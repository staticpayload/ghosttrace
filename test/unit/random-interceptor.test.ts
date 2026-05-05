import { describe, expect, it } from 'vitest';
import { SpanType, deserialize, ghost, type SerializedJsonValue, type Span } from '../../src/index.js';

function randomSpans(spans: readonly Span[]): readonly Span[] {
  return spans.filter((span) => span.type === SpanType.Random);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deserializeAs<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

describe('random interceptor', () => {
  it('records and replays 1000 Math.random calls exactly in order', async () => {
    const trace = await ghost.record(
      'math-random-sequence',
      () => Array.from({ length: 1000 }, () => Math.random()),
      { interceptors: ['random'] }
    );
    const spans = randomSpans(trace.spans);
    const expectedSequence = deserializeAs<readonly number[]>(trace.spans[0]?.output);

    expect(spans).toHaveLength(1000);
    expect(spans.every((span) => span.name === 'Math.random')).toBe(true);
    expect(spans.map((span) => span.output)).toEqual(expectedSequence);

    const replayed = await ghost.replay(trace, () => Array.from({ length: 1000 }, () => Math.random()));

    expect(replayed.output).toEqual(expectedSequence);
    expect(replayed.spansMatched).toHaveLength(1000);
    expect(replayed.spansMatched.every((match) => match.span.name === 'Math.random')).toBe(true);
  });

  it('records and replays crypto.getRandomValues byte-for-byte while returning the same typed array', async () => {
    const originalGetRandomValues = globalThis.crypto.getRandomValues;
    const trace = await ghost.record(
      'crypto-random-values',
      () => {
        const bytes = new Uint8Array(32);
        const returned = globalThis.crypto.getRandomValues(bytes);

        return {
          sameReference: returned === bytes,
          bytes: Array.from(bytes)
        };
      },
      { interceptors: ['random'] }
    );
    const span = randomSpans(trace.spans)[0];
    const expectedOutput = deserializeAs<{
      readonly sameReference: boolean;
      readonly bytes: readonly number[];
    }>(trace.spans[0]?.output);

    expect(globalThis.crypto.getRandomValues).toBe(originalGetRandomValues);
    expect(span).toMatchObject({
      name: 'crypto.getRandomValues',
      input: {
        constructorName: 'Uint8Array',
        byteLength: 32
      },
      metadata: {
        source: 'crypto',
        operation: 'getRandomValues',
        byteLength: 32
      }
    });
    expect(isRecord(span?.output) ? span.output.bytesBase64 : undefined).toEqual(expect.any(String));
    expect(expectedOutput.bytes).toHaveLength(32);

    const replayed = await ghost.replay(trace, () => {
      const bytes = new Uint8Array(32);
      const returned = globalThis.crypto.getRandomValues(bytes);

      return {
        sameReference: returned === bytes,
        bytes: Array.from(bytes)
      };
    });

    expect(replayed.output).toEqual(expectedOutput);
    expect(globalThis.crypto.getRandomValues).toBe(originalGetRandomValues);
  });
});
