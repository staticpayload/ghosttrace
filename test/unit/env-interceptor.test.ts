import { afterEach, describe, expect, it } from 'vitest';
import { ReplayMismatchError, SpanType, deserialize, ghost, type SerializedJsonValue, type Span } from '../../src/index.js';

const ENV_KEY = 'GHOSTTRACE_ENV_INTERCEPTOR_TEST_VALUE';
const ENV_REORDERED_FIRST_KEY = 'GHOSTTRACE_ENV_INTERCEPTOR_REORDERED_FIRST';
const ENV_REORDERED_SECOND_KEY = 'GHOSTTRACE_ENV_INTERCEPTOR_REORDERED_SECOND';
const ENV_STRICT_RECORDED_KEY = 'GHOSTTRACE_ENV_INTERCEPTOR_STRICT_RECORDED';
const ENV_STRICT_ACTUAL_KEY = 'GHOSTTRACE_ENV_INTERCEPTOR_STRICT_ACTUAL';
const envKeys = [
  ENV_KEY,
  ENV_REORDERED_FIRST_KEY,
  ENV_REORDERED_SECOND_KEY,
  ENV_STRICT_RECORDED_KEY,
  ENV_STRICT_ACTUAL_KEY
] as const;
const originalValues = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]));

function envSpans(spans: readonly Span[]): readonly Span[] {
  return spans.filter((span) => span.type === SpanType.Env);
}

function envSpansForKey(spans: readonly Span[], key: string): readonly Span[] {
  return envSpans(spans).filter((span) => span.metadata.key === key);
}

function deserializeAs<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

function restoreEnvValue(key: string): void {
  const originalValue = originalValues.get(key);

  if (originalValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = originalValue;
  }
}

function spanInputKey(span: Span | undefined): unknown {
  const input = span?.input;

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }

  return (input as Readonly<Record<string, unknown>>).key;
}

describe('environment interceptor', () => {
  afterEach(() => {
    for (const key of envKeys) {
      restoreEnvValue(key);
    }
  });

  it('records process.env reads, writes, and deletes with operation metadata', async () => {
    const originalEnv = process.env;
    delete process.env[ENV_KEY];

    const trace = await ghost.record(
      'env-operations',
      () => {
        expect(process.env).not.toBe(originalEnv);

        const before = process.env[ENV_KEY];
        process.env[ENV_KEY] = 'recorded-value';
        const after = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
        const deleted = process.env[ENV_KEY];

        return {
          before,
          after,
          deleted
        };
      },
      { interceptors: ['env'] }
    );

    expect(process.env).toBe(originalEnv);
    const keySpans = envSpansForKey(trace.spans, ENV_KEY);

    expect(keySpans.map((span) => span.name)).toEqual([
      'process.env.get',
      'process.env.set',
      'process.env.get',
      'process.env.delete',
      'process.env.get'
    ]);
    expect(keySpans.map((span) => span.metadata.operation)).toEqual([
      'get',
      'set',
      'get',
      'delete',
      'get'
    ]);
    expect(deserializeAs(trace.spans[0]?.output)).toEqual({
      before: undefined,
      after: 'recorded-value',
      deleted: undefined
    });
  });

  it('replays recorded env reads regardless of actual env values and keeps replay writes isolated', async () => {
    process.env[ENV_KEY] = 'recorded-start';

    const trace = await ghost.record(
      'env-replay',
      () => {
        const before = process.env[ENV_KEY];
        process.env[ENV_KEY] = 'recorded-write';
        const after = process.env[ENV_KEY];
        delete process.env[ENV_KEY];
        const deleted = process.env[ENV_KEY];

        return {
          before,
          after,
          deleted
        };
      },
      { interceptors: ['env'] }
    );
    const originalEnv = process.env;
    process.env[ENV_KEY] = 'actual-replay-value';

    const replayed = await ghost.replay(trace, () => {
      const before = process.env[ENV_KEY];
      process.env[ENV_KEY] = 'live-replay-write';
      const after = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      const deleted = process.env[ENV_KEY];

      return {
        before,
        after,
        deleted
      };
    });

    expect(replayed.output).toEqual({
      before: 'recorded-start',
      after: 'recorded-write',
      deleted: undefined
    });
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual([
      'process.env.get',
      'process.env.set',
      'process.env.get',
      'process.env.delete',
      'process.env.get'
    ]);
    expect(process.env).toBe(originalEnv);
    expect(process.env[ENV_KEY]).toBe('actual-replay-value');
  });

  it('matches replayed env reads by key when access order changes', async () => {
    process.env[ENV_REORDERED_FIRST_KEY] = 'recorded-first';
    process.env[ENV_REORDERED_SECOND_KEY] = 'recorded-second';

    const trace = await ghost.record(
      'env-reordered-replay',
      () => ({
        first: process.env[ENV_REORDERED_FIRST_KEY],
        second: process.env[ENV_REORDERED_SECOND_KEY]
      }),
      { interceptors: ['env'] }
    );

    process.env[ENV_REORDERED_FIRST_KEY] = 'actual-first';
    process.env[ENV_REORDERED_SECOND_KEY] = 'actual-second';

    const replayed = await ghost.replay(trace, () => ({
      second: process.env[ENV_REORDERED_SECOND_KEY],
      first: process.env[ENV_REORDERED_FIRST_KEY]
    }));

    expect(replayed.output).toEqual({
      second: 'recorded-second',
      first: 'recorded-first'
    });
    expect(replayed.spansMatched.map((match) => spanInputKey(match.span))).toEqual([
      ENV_REORDERED_SECOND_KEY,
      ENV_REORDERED_FIRST_KEY
    ]);
    expect(replayed.spansMatched.map((match) => match.strategy)).toEqual(['input', 'input']);
  });

  it('throws ReplayMismatchError for an unmatched env key in strict replay mode', async () => {
    process.env[ENV_STRICT_RECORDED_KEY] = 'recorded-strict-env';
    process.env[ENV_STRICT_ACTUAL_KEY] = 'actual-strict-env';

    const trace = await ghost.record('env-strict-key-mismatch', () => process.env[ENV_STRICT_RECORDED_KEY], {
      interceptors: ['env']
    });

    await expect(
      ghost.replay(trace, () => process.env[ENV_STRICT_ACTUAL_KEY], {
        mode: 'strict'
      })
    ).rejects.toMatchObject({
      name: ReplayMismatchError.name,
      code: 'GHOSTTRACE_REPLAY_MISMATCH',
      context: {
        spanType: SpanType.Env,
        name: 'process.env.get',
        expectedIdentity: {
          operation: 'get',
          key: ENV_STRICT_RECORDED_KEY
        },
        actualIdentity: {
          operation: 'get',
          key: ENV_STRICT_ACTUAL_KEY
        }
      }
    });
  });

  it('falls back sequentially for an unmatched env key in lenient replay mode', async () => {
    process.env[ENV_STRICT_RECORDED_KEY] = 'recorded-lenient-env';
    process.env[ENV_STRICT_ACTUAL_KEY] = 'actual-lenient-env';

    const trace = await ghost.record('env-lenient-key-mismatch', () => process.env[ENV_STRICT_RECORDED_KEY], {
      interceptors: ['env']
    });

    const replayed = await ghost.replay(
      trace,
      () => ({
        value: process.env[ENV_STRICT_ACTUAL_KEY]
      }),
      {
        mode: 'lenient'
      }
    );

    expect(replayed.output).toEqual({ value: 'recorded-lenient-env' });
    expect(replayed.spansMatched.map((match) => spanInputKey(match.span))).toEqual([ENV_STRICT_RECORDED_KEY]);
    expect(replayed.spansMatched.map((match) => match.strategy)).toEqual(['sequential']);
  });
});
