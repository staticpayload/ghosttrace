import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReplayExhaustedError,
  ReplayMismatchError,
  SpanType,
  ghost,
  type Span,
  type Trace
} from '../../src/index.js';

function httpSpans(trace: Trace): readonly Span[] {
  return trace.spans.filter((span) => span.type === SpanType.Http);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () => resolvePromise?.()
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('advanced replay behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('matches concurrent Promise.all fetches independently by recorded input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => new Response(`recorded:${new URL(String(input)).pathname}`))
    );
    const trace = await ghost.record(
      'concurrent-fetch-replay',
      async () => {
        const [first, second, third] = await Promise.all([
          fetch('https://api.example.test/first').then((response) => response.text()),
          fetch('https://api.example.test/second').then((response) => response.text()),
          fetch('https://api.example.test/third').then((response) => response.text())
        ]);

        return { first, second, third };
      },
      { interceptors: ['http'] }
    );
    const recordedHttpSpans = httpSpans(trace);
    const liveFetch = vi.fn(async () => {
      throw new Error('concurrent replay should satisfy every fetch from the trace');
    });
    vi.stubGlobal('fetch', liveFetch);

    const replayed = await ghost.replay(trace, async () => {
      const [third, first, second] = await Promise.all([
        fetch('https://api.example.test/third').then((response) => response.text()),
        fetch('https://api.example.test/first').then((response) => response.text()),
        fetch('https://api.example.test/second').then((response) => response.text())
      ]);

      return { third, first, second };
    });

    expect(replayed.output).toEqual({
      third: 'recorded:/third',
      first: 'recorded:/first',
      second: 'recorded:/second'
    });
    expect(replayed.spansMatched.map((match) => match.span.id)).toEqual([
      recordedHttpSpans[2]?.id,
      recordedHttpSpans[0]?.id,
      recordedHttpSpans[1]?.id
    ]);
    expect(replayed.spansMatched.map((match) => match.strategy)).toEqual(['input', 'input', 'input']);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it('composes nested intercepted Date.now calls inside replayed setTimeout callbacks', async () => {
    const trace = await ghost.record(
      'nested-timer-date-replay',
      () =>
        new Promise<number>((resolve) => {
          setTimeout(() => {
            resolve(Date.now());
          }, 5);
        }),
      { interceptors: ['timer'] }
    );
    const recordedDateNowSpan = trace.spans.find((span) => span.type === SpanType.Timer && span.name === 'Date.now');

    const replayed = await ghost.replay(trace, () =>
      new Promise<number>((resolve) => {
        setTimeout(() => {
          resolve(Date.now());
        }, 5);
      })
    );

    expect(replayed.output).toBe((recordedDateNowSpan?.output as Readonly<Record<string, unknown>> | undefined)?.value);
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual(['setTimeout', 'Date.now']);
  });

  it('times out non-completing replay functions and restores installed stubs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('recorded')));
    const trace = await ghost.record(
      'timeout-cleans-up-replay-stubs',
      async () => {
        const response = await fetch('https://api.example.test/timeout-cleanup');
        return response.text();
      },
      { interceptors: ['http', 'timer'] }
    );
    const liveFetch = vi.fn(async () => new Response('live-after-timeout'));
    vi.stubGlobal('fetch', liveFetch);
    const originalDate = Date;
    const startedAt = performance.now();

    await expect(
      ghost.replay(trace, () => new Promise<never>(() => undefined), { timeout: 100 })
    ).rejects.toMatchObject({
      name: ReplayMismatchError.name,
      code: 'GHOSTTRACE_REPLAY_TIMEOUT',
      context: {
        timeout: 100
      }
    });

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(globalThis.fetch).toBe(liveFetch);
    expect(Date).toBe(originalDate);
    await expect(fetch('https://api.example.test/live-after-timeout').then((response) => response.text())).resolves.toBe(
      'live-after-timeout'
    );
  });

  it('isolates overlapping replay sessions for the same trace id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => new Response(`recorded:${new URL(String(input)).pathname}`))
    );
    const trace = await ghost.record(
      'parallel-same-trace-replay',
      async () => {
        const first = await fetch('https://api.example.test/first').then((response) => response.text());
        const second = await fetch('https://api.example.test/second').then((response) => response.text());
        return { first, second };
      },
      { interceptors: ['http'] }
    );
    const firstReplayPaused = deferred();
    const releaseFirstReplay = deferred();
    const liveFetch = vi.fn(async () => {
      throw new Error('parallel replay sessions should not fall through to live fetch');
    });
    vi.stubGlobal('fetch', liveFetch);

    const firstReplay = ghost.replay(trace, async () => {
      const first = await fetch('https://api.example.test/first').then((response) => response.text());
      firstReplayPaused.resolve();
      await releaseFirstReplay.promise;
      const second = await fetch('https://api.example.test/second').then((response) => response.text());

      return { first, second };
    });

    await firstReplayPaused.promise;

    const secondReplay = await ghost.replay(trace, async () => {
      const first = await fetch('https://api.example.test/first').then((response) => response.text());
      const second = await fetch('https://api.example.test/second').then((response) => response.text());

      return { first, second };
    });

    releaseFirstReplay.resolve();
    await nextTurn();
    const firstReplayResult = await firstReplay;

    expect(secondReplay.output).toEqual({
      first: 'recorded:/first',
      second: 'recorded:/second'
    });
    expect(firstReplayResult.output).toEqual(secondReplay.output);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it('throws ReplayExhaustedError with span counts when runtime calls exceed recorded spans', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(`recorded:${String(input)}`)));
    const trace = await ghost.record(
      'replay-exhaustion',
      async () => {
        await fetch('https://api.example.test/one');
        await fetch('https://api.example.test/two');
        await fetch('https://api.example.test/three');
      },
      { interceptors: ['http'] }
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('live')));

    await expect(
      ghost.replay(trace, async () => {
        await fetch('https://api.example.test/one');
        await fetch('https://api.example.test/two');
        await fetch('https://api.example.test/three');
        await fetch('https://api.example.test/four');
      })
    ).rejects.toMatchObject({
      name: ReplayExhaustedError.name,
      code: 'GHOSTTRACE_REPLAY_EXHAUSTED',
      context: {
        spanType: SpanType.Http,
        name: 'fetch',
        availableSpanCount: 3,
        attemptedCount: 4
      }
    });
  });

  it('reports expected and actual input details when replay arguments drift', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('recorded')));
    const trace = await ghost.record(
      'argument-drift',
      async () => {
        await fetch('https://api.example.test/expected', {
          method: 'POST',
          headers: { 'x-ghosttrace-test': 'expected' },
          body: 'expected-body'
        });
      },
      { interceptors: ['http'] }
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('live')));

    await expect(
      ghost.replay(trace, async () => {
        await fetch('https://api.example.test/actual', {
          method: 'POST',
          headers: { 'x-ghosttrace-test': 'actual' },
          body: 'actual-body'
        });
      })
    ).rejects.toMatchObject({
      name: ReplayMismatchError.name,
      code: 'GHOSTTRACE_REPLAY_MISMATCH',
      context: {
        spanType: SpanType.Http,
        name: 'fetch',
        expectedInput: expect.objectContaining({
          url: 'https://api.example.test/expected',
          body: 'expected-body'
        }),
        actualInput: expect.objectContaining({
          url: 'https://api.example.test/actual',
          body: 'actual-body'
        }),
        inputDiffs: expect.arrayContaining([
          expect.objectContaining({
            path: '$.url',
            expected: 'https://api.example.test/expected',
            actual: 'https://api.example.test/actual'
          })
        ])
      }
    });
  });
});
