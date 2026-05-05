import { afterEach, describe, expect, it } from 'vitest';
import { SpanType, deserialize, ghost, type SerializedJsonValue, type Span } from '../../src/index.js';

const ENV_KEY = 'GHOSTTRACE_ENV_INTERCEPTOR_TEST_VALUE';
let originalValue: string | undefined = process.env[ENV_KEY];

function envSpans(spans: readonly Span[]): readonly Span[] {
  return spans.filter((span) => span.type === SpanType.Env);
}

function envSpansForKey(spans: readonly Span[], key: string): readonly Span[] {
  return envSpans(spans).filter((span) => span.metadata.key === key);
}

function deserializeAs<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

describe('environment interceptor', () => {
  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalValue;
    }
    originalValue = process.env[ENV_KEY];
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
});
