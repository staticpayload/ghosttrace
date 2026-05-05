import { describe, expect, it } from 'vitest';
import { SpanType, TRACE_FORMAT_VERSION, createTrace, defineConfig, ghost } from '../../src/index.js';

describe('public API foundation', () => {
  it('exports a minimal trace factory and SpanType values for consumers', () => {
    const trace = createTrace({ id: 'trace_1', name: 'foundation', spans: [] });

    expect(trace.id).toBe('trace_1');
    expect(trace.name).toBe('foundation');
    expect(trace.version).toBe(TRACE_FORMAT_VERSION);
    expect(trace.spans).toEqual([]);
    expect(SpanType.Function).toBe('function');
  });

  it('exposes a typed ghost namespace and defineConfig helper without import side effects', () => {
    const config = defineConfig({ traceDir: '__ghosttraces__', interceptors: ['function'] });

    expect(config.traceDir).toBe('__ghosttraces__');
    expect(config.interceptors).toEqual(['function']);
    expect(ghost.defineConfig(config)).toEqual(config);
  });
});
