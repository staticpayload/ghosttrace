import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  deserialize,
  serialize,
  serializeToJsonChunks,
  stringifySerialized,
  writeSerializedJson
} from '../../src/index.js';

describe('serializer', () => {
  it('round-trips primitives and JSON-unsafe number values', () => {
    expect(deserialize(serialize(null))).toBeNull();
    expect(deserialize(serialize(undefined))).toBeUndefined();
    expect(deserialize(serialize(true))).toBe(true);
    expect(deserialize(serialize(42))).toBe(42);
    expect(deserialize(serialize('ghost'))).toBe('ghost');
    expect(deserialize(serialize(9007199254740993n))).toBe(9007199254740993n);
    expect(Number.isNaN(deserialize<number>(serialize(Number.NaN)))).toBe(true);
    expect(deserialize(serialize(Number.POSITIVE_INFINITY))).toBe(Number.POSITIVE_INFINITY);
    expect(Object.is(deserialize(serialize(-0)), -0)).toBe(true);
  });

  it('round-trips Date, Buffer, RegExp, Error, Map, and Set values', () => {
    const createdAt = new Date('2026-05-05T06:00:00.123Z');
    const buffer = Buffer.from('ghosttrace-buffer', 'utf8');
    const pattern = /ghost(trace)?/giu;
    pattern.lastIndex = 2;
    const cause = new TypeError('inner cause');
    const error = new RangeError('outer message', { cause });
    const mapKey = { id: 'key' };
    const map = new Map<unknown, unknown>([
      ['createdAt', createdAt],
      [mapKey, buffer]
    ]);
    const set = new Set<unknown>([pattern, error, 'stable']);

    expect(deserialize<Date>(serialize(createdAt))).toEqual(createdAt);
    expect(Buffer.isBuffer(deserialize(serialize(buffer)))).toBe(true);
    expect(deserialize<Buffer>(serialize(buffer)).equals(buffer)).toBe(true);

    const roundTripPattern = deserialize<RegExp>(serialize(pattern));
    expect(roundTripPattern).toBeInstanceOf(RegExp);
    expect(roundTripPattern.source).toBe(pattern.source);
    expect(roundTripPattern.flags).toBe(pattern.flags);
    expect(roundTripPattern.lastIndex).toBe(2);

    const roundTripError = deserialize<Error & { cause?: unknown }>(serialize(error));
    expect(roundTripError).toBeInstanceOf(Error);
    expect(roundTripError.name).toBe('RangeError');
    expect(roundTripError.message).toBe('outer message');
    expect(roundTripError.cause).toBeInstanceOf(Error);
    expect((roundTripError.cause as Error).message).toBe('inner cause');

    const roundTripMap = deserialize<Map<unknown, unknown>>(serialize(map));
    expect(roundTripMap).toBeInstanceOf(Map);
    expect(roundTripMap.get('createdAt')).toEqual(createdAt);
    const roundTripMapKeys = [...roundTripMap.keys()];
    const roundTripObjectKey = roundTripMapKeys[1];
    expect(roundTripMap.get(mapKey)).toBeUndefined();
    expect(roundTripMapKeys).toEqual(['createdAt', mapKey]);
    expect(roundTripObjectKey).toEqual(mapKey);
    expect(roundTripMap.get(roundTripObjectKey)).toEqual(buffer);

    const roundTripSet = deserialize<Set<unknown>>(serialize(set));
    expect(roundTripSet).toBeInstanceOf(Set);
    expect([...roundTripSet].some((value) => value instanceof RegExp && value.source === pattern.source)).toBe(
      true
    );
    expect([...roundTripSet].some((value) => value instanceof Error && value.message === 'outer message')).toBe(
      true
    );
    expect(roundTripSet.has('stable')).toBe(true);
  });

  it('replaces functions with serializable placeholders', () => {
    function namedPlaceholder(): void {
      return undefined;
    }

    const serialized = serialize({ fn: namedPlaceholder });

    expect(serialized).toEqual({
      fn: {
        __type: 'Function',
        name: 'namedPlaceholder'
      }
    });
    expect(JSON.stringify(serialized)).toContain('namedPlaceholder');
  });

  it('marks shallow and deeply nested circular references without throwing', () => {
    const root: { name: string; self?: unknown; child?: { parent?: unknown } } = { name: 'root' };
    root.self = root;
    root.child = { parent: root };

    const serialized = serialize(root);

    expect(serialized).toEqual({
      name: 'root',
      self: { __type: 'CircularRef', path: '$' },
      child: {
        parent: { __type: 'CircularRef', path: '$' }
      }
    });
  });

  it('enforces a configurable depth limit with truncation markers', () => {
    const nested = {
      level: 1,
      next: {
        level: 2,
        next: {
          level: 3,
          next: {
            level: 4,
            next: {
              level: 5
            }
          }
        }
      }
    };

    const serialized = serialize(nested, { maxDepth: 3 });

    expect(serialized).toEqual({
      level: 1,
      next: {
        level: 2,
        next: {
          level: 3,
          next: {
            __type: 'Truncated',
            maxDepth: 3,
            path: '$.next.next.next'
          }
        }
      }
    });
  });

  it('preserves undefined properties and sparse arrays through JSON round-trip', () => {
    const sparse: unknown[] = [];
    sparse.length = 4;
    sparse[1] = undefined;
    sparse[3] = 'tail';

    const serialized = serialize({ present: undefined, sparse });
    const parsed = JSON.parse(JSON.stringify(serialized)) as ReturnType<typeof serialize>;
    const roundTrip = deserialize<{ present?: unknown; sparse: unknown[] }>(parsed);

    expect(Object.prototype.hasOwnProperty.call(roundTrip, 'present')).toBe(true);
    expect(roundTrip.present).toBeUndefined();
    expect(roundTrip.sparse).toHaveLength(4);
    expect(0 in roundTrip.sparse).toBe(false);
    expect(1 in roundTrip.sparse).toBe(true);
    expect(roundTrip.sparse[1]).toBeUndefined();
    expect(2 in roundTrip.sparse).toBe(false);
    expect(roundTrip.sparse[3]).toBe('tail');
  });

  it('streams large serialized JSON files without changing the serialized representation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ghosttrace-serializer-'));
    const outputPath = join(directory, 'large.ghosttrace.json');
    const tenMiB = 10 * 1024 * 1024;
    const largeTrace = {
      id: 'trace_large',
      spans: Array.from({ length: 1100 }, (_, index) => ({
        id: `span_${index}`,
        payload: 'x'.repeat(10_000)
      }))
    };

    try {
      await writeSerializedJson(outputPath, largeTrace, { chunkSize: 16 * 1024 });

      const fileStat = await stat(outputPath);
      expect(fileStat.size).toBeGreaterThan(tenMiB);

      const parsed = JSON.parse(await readFile(outputPath, 'utf8')) as ReturnType<typeof serialize>;
      expect(parsed).toEqual(serialize(largeTrace));
      expect(stringifySerialized(largeTrace)).toBe(JSON.stringify(serialize(largeTrace)));

      const chunks = [
        ...serializeToJsonChunks({ payload: 'y'.repeat(70_000) }, { chunkSize: 4096 })
      ];
      expect(chunks.length).toBeGreaterThan(1);
      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(4096);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
