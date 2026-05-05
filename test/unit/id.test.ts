import { describe, expect, it } from 'vitest';
import { createIdGenerator } from '../../src/index.js';

describe('deterministic ID generator', () => {
  it('produces sequential span IDs with deterministic formatting', () => {
    const generator = createIdGenerator({ prefix: 'span', start: 1, width: 4 });

    expect([generator.next(), generator.next(), generator.next()]).toEqual([
      'span_0001',
      'span_0002',
      'span_0003'
    ]);
  });

  it('resets per trace so separate recordings start from the same base', () => {
    const traceAIds = createIdGenerator({ prefix: 'span' });
    const traceBIds = createIdGenerator({ prefix: 'span' });

    expect(traceAIds.next()).toBe('span_0001');
    expect(traceAIds.next()).toBe('span_0002');
    expect(traceBIds.next()).toBe('span_0001');
    expect(traceBIds.next()).toBe('span_0002');
  });

  it('does not duplicate IDs within a trace', () => {
    const generator = createIdGenerator({ prefix: 'span' });
    const ids = Array.from({ length: 100 }, () => generator.next());

    expect(new Set(ids).size).toBe(100);
    expect(ids[0]).toBe('span_0001');
    expect(ids.at(-1)).toBe('span_0100');
  });

  it('can peek and reset without consuming the deterministic sequence', () => {
    const generator = createIdGenerator({ prefix: 'trace', start: 0, width: 3 });

    expect(generator.peek()).toBe('trace_000');
    expect(generator.next()).toBe('trace_000');
    expect(generator.peek()).toBe('trace_001');

    generator.reset();

    expect(generator.next()).toBe('trace_000');
  });
});
