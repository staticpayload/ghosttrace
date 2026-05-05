import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SpanType,
  deserialize,
  ghost,
  registerInterceptor,
  wrapDb,
  wrapQueue,
  type DbAdapter,
  type QueueAdapter,
  type SerializedJsonValue,
  type Span
} from '../../src/index.js';

interface QueryResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number;
}

interface FakeDbClient {
  readonly query: (query: string, params?: readonly unknown[]) => Promise<QueryResult>;
  readonly begin: () => Promise<string>;
  readonly commit: (transactionId: string) => Promise<{ readonly transactionId: string }>;
  readonly rollback: (transactionId: string) => Promise<{ readonly transactionId: string }>;
}

interface QueueMessage {
  readonly id: string;
  readonly payload: unknown;
}

interface FakeQueueClient {
  readonly send: (queueName: string, payload: unknown) => Promise<{ readonly id: string }>;
  readonly receive: (queueName: string) => Promise<QueueMessage>;
  readonly ack: (queueName: string, messageId: string) => Promise<{ readonly acknowledged: true }>;
  readonly nack: (queueName: string, messageId: string, reason?: string) => Promise<{ readonly requeued: false }>;
}

interface PromiseRowsDbClient {
  readonly query: (query: string) => Promise<readonly Readonly<Record<string, unknown>>[]>;
}

interface PromiseRejectingQueueClient {
  readonly nack: (queueName: string, messageId: string) => Promise<{ readonly requeued: false }>;
}

const unregisterCallbacks: Array<() => void> = [];

function spansOfType(spans: readonly Span[], type: SpanType): readonly Span[] {
  return spans.filter((span) => span.type === type);
}

function spanAt(spans: readonly Span[], index: number): Span {
  const span = spans[index];
  if (span === undefined) {
    throw new Error(`expected span at index ${index}`);
  }

  return span;
}

function deserializeAs<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

function queryText(args: readonly unknown[]): string {
  const [query] = args;
  if (typeof query !== 'string') {
    throw new TypeError('expected query string');
  }

  return query;
}

function queueName(args: readonly unknown[]): string {
  const [name] = args;
  if (typeof name !== 'string') {
    throw new TypeError('expected queue name');
  }

  return name;
}

function messageIdFromArgs(args: readonly unknown[]): string | undefined {
  const [, messageId] = args;
  return typeof messageId === 'string' ? messageId : undefined;
}

function messageIdFromResult(_args: readonly unknown[], result: unknown): string | undefined {
  return typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string'
    ? result.id
    : undefined;
}

function payloadFromReceive(_args: readonly unknown[], result: unknown): unknown {
  return typeof result === 'object' && result !== null && 'payload' in result ? result.payload : undefined;
}

function createDbClient(): FakeDbClient {
  return {
    async query(query: string, params: readonly unknown[] = []): Promise<QueryResult> {
      if (query.includes('FAIL')) {
        throw new Error('db failed');
      }

      const operation = query.trim().split(/\s+/u)[0]?.toUpperCase();
      if (operation === 'SELECT') {
        return {
          rows: [{ id: params[0], name: 'Ada' }],
          rowCount: 1
        };
      }

      return {
        rows: [],
        rowCount: 2
      };
    },
    async begin(): Promise<string> {
      return 'tx-1';
    },
    async commit(transactionId: string): Promise<{ readonly transactionId: string }> {
      return { transactionId };
    },
    async rollback(transactionId: string): Promise<{ readonly transactionId: string }> {
      return { transactionId };
    }
  };
}

function createPromiseRowsDbClient(): PromiseRowsDbClient {
  return {
    query(_query: string): Promise<readonly Readonly<Record<string, unknown>>[]> {
      return Promise.resolve([{ id: 'raw-1', name: 'Raw Ada' }]);
    }
  };
}

function createPromiseRejectingQueueClient(): PromiseRejectingQueueClient {
  return {
    nack(_queueName: string, _messageId: string): Promise<{ readonly requeued: false }> {
      return Promise.reject(new Error('promise nack failed'));
    }
  };
}

function createDbAdapter(): DbAdapter<FakeDbClient> {
  return {
    name: 'fake-db',
    operations: [
      {
        method: 'query',
        query: queryText,
        params: (args) => args[1],
        result: (result) => (typeof result === 'object' && result !== null && 'rows' in result ? result.rows : undefined),
        rowCount: (result) =>
          typeof result === 'object' && result !== null && 'rowCount' in result && typeof result.rowCount === 'number'
            ? result.rowCount
            : undefined
      }
    ],
    transactions: [
      {
        method: 'begin',
        operation: 'begin',
        transactionId: (_args, result) => (typeof result === 'string' ? result : undefined)
      },
      {
        method: 'commit',
        operation: 'commit',
        transactionId: (args) => (typeof args[0] === 'string' ? args[0] : undefined)
      },
      {
        method: 'rollback',
        operation: 'rollback',
        transactionId: (args) => (typeof args[0] === 'string' ? args[0] : undefined)
      }
    ]
  };
}

function createFullResultDbAdapter(): DbAdapter<FakeDbClient> {
  return {
    name: 'fake-db',
    operations: [
      {
        method: 'query',
        query: queryText,
        params: (args) => args[1],
        rowCount: (result) =>
          typeof result === 'object' && result !== null && 'rowCount' in result && typeof result.rowCount === 'number'
            ? result.rowCount
            : undefined
      }
    ]
  };
}

function createPromiseRowsDbAdapter(): DbAdapter<PromiseRowsDbClient> {
  return {
    name: 'promise-rows-db',
    operations: [
      {
        method: 'query',
        query: queryText,
        rowCount: (result) => (Array.isArray(result) ? result.length : undefined)
      }
    ]
  };
}

function createQueueClient(): FakeQueueClient {
  return {
    async send(_queueName: string, _payload: unknown): Promise<{ readonly id: string }> {
      return { id: 'msg-1' };
    },
    async receive(_queueName: string): Promise<QueueMessage> {
      return {
        id: 'msg-2',
        payload: { task: 'index', priority: 3 }
      };
    },
    async ack(_queueName: string, _messageId: string): Promise<{ readonly acknowledged: true }> {
      return { acknowledged: true };
    },
    async nack(_queueName: string, _messageId: string, reason?: string): Promise<{ readonly requeued: false }> {
      if (reason === 'explode') {
        throw new Error('nack failed');
      }

      return { requeued: false };
    }
  };
}

function createPromiseRejectingQueueAdapter(): QueueAdapter<PromiseRejectingQueueClient> {
  return {
    name: 'promise-queue',
    operations: [
      {
        method: 'nack',
        operation: 'nack',
        queueName,
        messageId: messageIdFromArgs
      }
    ]
  };
}

function createQueueAdapter(): QueueAdapter<FakeQueueClient> {
  return {
    name: 'memory-queue',
    operations: [
      {
        method: 'send',
        operation: 'send',
        queueName,
        payload: (args) => args[1],
        messageId: messageIdFromResult
      },
      {
        method: 'receive',
        operation: 'receive',
        queueName,
        payload: payloadFromReceive,
        messageId: messageIdFromResult
      },
      {
        method: 'ack',
        operation: 'ack',
        queueName,
        messageId: messageIdFromArgs
      },
      {
        method: 'nack',
        operation: 'nack',
        queueName,
        messageId: messageIdFromArgs,
        payload: (args) => args[2]
      }
    ]
  };
}

describe('DB, queue, and performance interceptors', () => {
  afterEach(() => {
    performance.clearMarks();
    performance.clearMeasures();

    while (unregisterCallbacks.length > 0) {
      unregisterCallbacks.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it('records DB SELECT/INSERT/UPDATE/DELETE results, row counts, errors, and transaction boundaries', async () => {
    const db = wrapDb(createDbClient(), createDbAdapter());

    const trace = await ghost.record(
      'db-operations',
      async () => {
        await db.query('SELECT * FROM users WHERE id = ?', [1]);
        await db.query('INSERT INTO users(name) VALUES (?)', ['Grace']);
        await db.query('UPDATE users SET name = ? WHERE id = ?', ['Katherine', 1]);
        await db.query('DELETE FROM users WHERE id = ?', [1]);
        try {
          await db.query('SELECT FAIL', []);
        } catch {
          // The DB interceptor should record the operation error while user code handles it.
        }

        const transactionId = await db.begin();
        await db.commit(transactionId);
        const rollbackId = await db.begin();
        await db.rollback(rollbackId);
      },
      { interceptors: ['db'] }
    );

    const dbSpans = spansOfType(trace.spans, SpanType.Db);
    expect(dbSpans.map((span) => span.metadata.operation)).toEqual([
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'SELECT',
      'begin',
      'commit',
      'begin',
      'rollback'
    ]);
    expect(dbSpans.map((span) => span.name)).toEqual([
      'db.query',
      'db.query',
      'db.query',
      'db.query',
      'db.query',
      'db.begin',
      'db.commit',
      'db.begin',
      'db.rollback'
    ]);

    expect(deserializeAs(spanAt(dbSpans, 0).input)).toEqual({
      adapter: 'fake-db',
      operation: 'SELECT',
      query: 'SELECT * FROM users WHERE id = ?',
      params: [1]
    });
    expect(deserializeAs(spanAt(dbSpans, 0).output)).toEqual({
      type: 'resolve',
      result: [{ id: 1, name: 'Ada' }],
      rowCount: 1
    });
    expect(deserializeAs(spanAt(dbSpans, 1).output)).toEqual({
      type: 'resolve',
      result: [],
      rowCount: 2
    });
    expect(spanAt(dbSpans, 4).error).toMatchObject({
      name: 'Error',
      message: 'db failed'
    });
    expect(deserializeAs(spanAt(dbSpans, 5).output)).toEqual({
      type: 'resolve',
      transactionId: 'tx-1',
      result: 'tx-1'
    });
    expect(deserializeAs(spanAt(dbSpans, 6).input)).toEqual({
      adapter: 'fake-db',
      operation: 'commit',
      transactionId: 'tx-1'
    });
  });

  it('records queue send/receive/ack/nack operations with message details and errors', async () => {
    const queue = wrapQueue(createQueueClient(), createQueueAdapter());

    const trace = await ghost.record(
      'queue-operations',
      async () => {
        await queue.send('jobs', { task: 'render', priority: 1 });
        const message = await queue.receive('jobs');
        await queue.ack('jobs', message.id);
        await queue.nack('jobs', 'msg-3', 'retry-later');
        try {
          await queue.nack('jobs', 'msg-4', 'explode');
        } catch {
          // The queue interceptor should record the operation error while user code handles it.
        }
      },
      { interceptors: ['queue'] }
    );

    const queueSpans = spansOfType(trace.spans, SpanType.Queue);

    expect(queueSpans.map((span) => span.metadata.operation)).toEqual(['send', 'receive', 'ack', 'nack', 'nack']);
    expect(deserializeAs(spanAt(queueSpans, 0).input)).toEqual({
      adapter: 'memory-queue',
      operation: 'send',
      queueName: 'jobs',
      payload: { task: 'render', priority: 1 }
    });
    expect(deserializeAs(spanAt(queueSpans, 0).output)).toEqual({
      type: 'resolve',
      messageId: 'msg-1',
      result: { id: 'msg-1' }
    });
    expect(deserializeAs(spanAt(queueSpans, 1).output)).toEqual({
      type: 'resolve',
      messageId: 'msg-2',
      payload: { task: 'index', priority: 3 },
      result: { id: 'msg-2', payload: { task: 'index', priority: 3 } }
    });
    expect(deserializeAs(spanAt(queueSpans, 2).input)).toEqual({
      adapter: 'memory-queue',
      operation: 'ack',
      queueName: 'jobs',
      messageId: 'msg-2'
    });
    expect(deserializeAs(spanAt(queueSpans, 3).input)).toEqual({
      adapter: 'memory-queue',
      operation: 'nack',
      queueName: 'jobs',
      messageId: 'msg-3',
      payload: 'retry-later'
    });
    expect(spanAt(queueSpans, 4).error).toMatchObject({
      name: 'Error',
      message: 'nack failed'
    });
  });

  it('replays DB and queue operations from recorded spans without calling live clients', async () => {
    const db = wrapDb(createDbClient(), createFullResultDbAdapter());
    const queue = wrapQueue(createQueueClient(), createQueueAdapter());

    const trace = await ghost.record(
      'db-queue-replay',
      async () => {
        const selected = await db.query('SELECT * FROM users WHERE id = ?', [7]);
        const message = await queue.receive('jobs');
        let dbError = 'missing db error';
        let queueError = 'missing queue error';

        try {
          await db.query('SELECT FAIL', []);
        } catch (error) {
          dbError = error instanceof Error ? error.message : String(error);
        }

        try {
          await queue.nack('jobs', 'msg-4', 'explode');
        } catch (error) {
          queueError = error instanceof Error ? error.message : String(error);
        }

        return {
          firstRow: selected.rows[0],
          rowCount: selected.rowCount,
          message,
          dbError,
          queueError
        };
      },
      { interceptors: ['db', 'queue'] }
    );

    const liveDbQuery = vi.fn(async (): Promise<QueryResult> => {
      throw new Error('live db query should not run during replay');
    });
    const liveDbClient: FakeDbClient = {
      query: liveDbQuery,
      begin: vi.fn(async () => 'live-tx'),
      commit: vi.fn(async (transactionId: string) => ({ transactionId })),
      rollback: vi.fn(async (transactionId: string) => ({ transactionId }))
    };
    const liveQueueReceive = vi.fn(async (): Promise<QueueMessage> => {
      throw new Error('live queue receive should not run during replay');
    });
    const liveQueueNack = vi.fn(async (): Promise<{ readonly requeued: false }> => {
      throw new Error('live queue nack should not run during replay');
    });
    const liveQueueClient: FakeQueueClient = {
      send: vi.fn(async () => ({ id: 'live-msg' })),
      receive: liveQueueReceive,
      ack: vi.fn(async (): Promise<{ readonly acknowledged: true }> => ({ acknowledged: true })),
      nack: liveQueueNack
    };
    const replayDb = wrapDb(liveDbClient, createFullResultDbAdapter());
    const replayQueue = wrapQueue(liveQueueClient, createQueueAdapter());

    const replayed = await ghost.replay(trace, async () => {
      const selected = await replayDb.query('SELECT * FROM users WHERE id = ?', [7]);
      const message = await replayQueue.receive('jobs');
      let dbError = 'missing db error';
      let queueError = 'missing queue error';

      try {
        await replayDb.query('SELECT FAIL', []);
      } catch (error) {
        dbError = error instanceof Error ? error.message : String(error);
      }

      try {
        await replayQueue.nack('jobs', 'msg-4', 'explode');
      } catch (error) {
        queueError = error instanceof Error ? error.message : String(error);
      }

      return {
        firstRow: selected.rows[0],
        rowCount: selected.rowCount,
        message,
        dbError,
        queueError
      };
    });

    expect(replayed.output).toEqual(deserializeAs(trace.spans[0]?.output));
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual([
      'db.query',
      'queue.receive',
      'db.query',
      'queue.nack'
    ]);
    expect(liveDbQuery).not.toHaveBeenCalled();
    expect(liveQueueReceive).not.toHaveBeenCalled();
    expect(liveQueueNack).not.toHaveBeenCalled();
  });

  it('preserves raw DB result payloads and Promise resolution for non-async adapter methods', async () => {
    const adapter = createPromiseRowsDbAdapter();
    const db = wrapDb(createPromiseRowsDbClient(), adapter);

    const trace = await ghost.record('db-raw-promise-result', () => db.query('SELECT raw rows'), {
      interceptors: ['db']
    });

    const dbSpan = spanAt(spansOfType(trace.spans, SpanType.Db), 0);
    expect(deserializeAs(dbSpan.output)).toEqual({
      type: 'resolve',
      result: [{ id: 'raw-1', name: 'Raw Ada' }],
      rowCount: 1
    });

    const liveDbQuery = vi.fn((_query: string): Promise<readonly Readonly<Record<string, unknown>>[]> =>
      Promise.reject(new Error('live rows query should not run during replay'))
    );
    const replayDb = wrapDb<PromiseRowsDbClient>({ query: liveDbQuery }, adapter);
    let returnedPromise = false;

    const replayed = await ghost.replay(trace, async () => {
      const rowsPromise = replayDb.query('SELECT raw rows');
      returnedPromise = isPromiseLike(rowsPromise);
      return rowsPromise;
    });

    expect(returnedPromise).toBe(true);
    expect(replayed.output).toEqual([{ id: 'raw-1', name: 'Raw Ada' }]);
    expect(liveDbQuery).not.toHaveBeenCalled();
  });

  it('replays queue rejections as Promise rejections for non-async adapter methods', async () => {
    const adapter = createPromiseRejectingQueueAdapter();
    const queue = wrapQueue(createPromiseRejectingQueueClient(), adapter);

    const trace = await ghost.record(
      'queue-promise-rejection',
      async () => {
        try {
          await queue.nack('jobs', 'msg-promise');
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }

        return 'missing rejection';
      },
      { interceptors: ['queue'] }
    );

    const queueSpan = spanAt(spansOfType(trace.spans, SpanType.Queue), 0);
    expect(deserializeAs(queueSpan.output)).toEqual({ type: 'reject' });
    expect(queueSpan.error).toMatchObject({
      name: 'Error',
      message: 'promise nack failed'
    });

    const liveQueueNack = vi.fn(
      (_queueName: string, _messageId: string): Promise<{ readonly requeued: false }> =>
        Promise.resolve({ requeued: false as const })
    );
    const replayQueue = wrapQueue<PromiseRejectingQueueClient>({ nack: liveQueueNack }, adapter);
    let returnedPromise = false;

    const replayed = await ghost.replay(trace, async () => {
      const rejectedPromise = replayQueue.nack('jobs', 'msg-promise');
      returnedPromise = isPromiseLike(rejectedPromise);

      try {
        await rejectedPromise;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }

      return 'missing rejection';
    });

    expect(returnedPromise).toBe(true);
    expect(replayed.output).toBe('promise nack failed');
    expect(liveQueueNack).not.toHaveBeenCalled();
  });

  it('records and replays performance.now, mark, and measure with exact values', async () => {
    const originalNow = performance.now;

    const trace = await ghost.record(
      'performance-api',
      () => {
        expect(performance.now).not.toBe(originalNow);

        const now = performance.now();
        const startMark = performance.mark('ghost-start');
        const endMark = performance.mark('ghost-end');
        const measure = performance.measure('ghost-duration', 'ghost-start', 'ghost-end');

        return {
          now,
          startMark: {
            name: startMark.name,
            entryType: startMark.entryType,
            startTime: startMark.startTime,
            duration: startMark.duration
          },
          endMarkName: endMark.name,
          measure: {
            name: measure.name,
            entryType: measure.entryType,
            startTime: measure.startTime,
            duration: measure.duration
          }
        };
      },
      { interceptors: ['performance'] }
    );

    expect(performance.now).toBe(originalNow);

    const performanceSpans = spansOfType(trace.spans, SpanType.Performance);
    expect(performanceSpans.map((span) => span.name)).toEqual([
      'performance.now',
      'performance.mark',
      'performance.mark',
      'performance.measure'
    ]);
    expect(deserializeAs(spanAt(performanceSpans, 0).input)).toEqual({ operation: 'now' });
    expect(spanAt(performanceSpans, 0).output).toBe(deserializeAs<{ readonly now: number }>(spanAt(trace.spans, 0).output).now);
    expect(deserializeAs(spanAt(performanceSpans, 1).input)).toEqual({
      operation: 'mark',
      markName: 'ghost-start'
    });
    expect(deserializeAs(spanAt(performanceSpans, 3).input)).toEqual({
      operation: 'measure',
      measureName: 'ghost-duration',
      startMark: 'ghost-start',
      endMark: 'ghost-end'
    });

    const expectedOutput = deserializeAs(spanAt(trace.spans, 0).output);
    const replayed = await ghost.replay(trace, () => {
      const now = performance.now();
      const startMark = performance.mark('ghost-start');
      const endMark = performance.mark('ghost-end');
      const measure = performance.measure('ghost-duration', 'ghost-start', 'ghost-end');

      return {
        now,
        startMark: {
          name: startMark.name,
          entryType: startMark.entryType,
          startTime: startMark.startTime,
          duration: startMark.duration
        },
        endMarkName: endMark.name,
        measure: {
          name: measure.name,
          entryType: measure.entryType,
          startTime: measure.startTime,
          duration: measure.duration
        }
      };
    });

    expect(replayed.output).toEqual(expectedOutput);
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual([
      'performance.now',
      'performance.mark',
      'performance.mark',
      'performance.measure'
    ]);
    expect(performance.now).toBe(originalNow);
  });

  it('records DB, queue, performance, timer, random, and env spans together in chronological order', async () => {
    const db = wrapDb(createDbClient(), createDbAdapter());
    const queue = wrapQueue(createQueueClient(), createQueueAdapter());
    const envKey = 'GHOSTTRACE_MULTI_INTERCEPTOR_ENV';
    const originalEnvValue = process.env[envKey];
    const originalNow = performance.now;

    try {
      const trace = await ghost.record(
        'all-interceptors',
        async () => {
          const timeout = setTimeout(() => undefined, 60_000);
          clearTimeout(timeout);
          Math.random();
          process.env[envKey] = 'enabled';
          performance.now();
          await db.query('SELECT * FROM users WHERE id = ?', [1]);
          await queue.send('jobs', { task: 'multi' });
        },
        { interceptors: ['timer', 'random', 'env', 'performance', 'db', 'queue'] }
      );

      const spanTypes = new Set(trace.spans.map((span) => span.type));
      expect(spanTypes.has(SpanType.Timer)).toBe(true);
      expect(spanTypes.has(SpanType.Random)).toBe(true);
      expect(spanTypes.has(SpanType.Env)).toBe(true);
      expect(spanTypes.has(SpanType.Performance)).toBe(true);
      expect(spanTypes.has(SpanType.Db)).toBe(true);
      expect(spanTypes.has(SpanType.Queue)).toBe(true);
      expect(trace.spans.map((span) => span.startTime)).toEqual(
        [...trace.spans.map((span) => span.startTime)].sort((left, right) => left - right)
      );
      expect(performance.now).toBe(originalNow);
    } finally {
      if (originalEnvValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalEnvValue;
      }
    }
  });

  it('skips unavailable interceptors silently by default and warns when explicitly requested', async () => {
    const install = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    unregisterCallbacks.push(
      registerInterceptor({
        name: 'unavailable-test',
        install,
        isAvailable: () => false
      })
    );

    await ghost.record('skip-unavailable-default', () => 'ok');
    expect(install).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    await ghost.record('skip-unavailable-explicit', () => 'ok', {
      interceptors: ['unavailable-test']
    });
    expect(install).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable-test'));
  });
});
