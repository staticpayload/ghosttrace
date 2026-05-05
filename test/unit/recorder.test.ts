import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SpanType,
  ghost,
  registerInterceptor,
  type Interceptor,
  type InterceptorContext,
  type Span
} from '../../src/index.js';

const unregisterCallbacks: Array<() => void> = [];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectSpans(spans: readonly Span[]): readonly Span[] {
  return spans.flatMap((span) => [span, ...collectSpans(span.children)]);
}

function httpUrls(traceSpans: readonly Span[]): readonly string[] {
  return traceSpans.flatMap((span) => {
    if (span.type !== SpanType.Http || !isRecord(span.input) || typeof span.input.url !== 'string') {
      return [];
    }

    return [span.input.url];
  });
}

function spanWithTiming(
  id: string,
  type: SpanType,
  name: string,
  startTime: number,
  endTime: number
): Span {
  return {
    id,
    parentId: null,
    type,
    name,
    startTime,
    endTime,
    duration: endTime - startTime,
    input: {},
    output: {},
    children: [],
    error: null,
    metadata: {}
  };
}

function registerTestInterceptor(interceptor: Interceptor): void {
  unregisterCallbacks.push(registerInterceptor(interceptor));
}

describe('recording engine', () => {
  afterEach(() => {
    while (unregisterCallbacks.length > 0) {
      unregisterCallbacks.pop()?.();
    }
    vi.restoreAllMocks();
  });

  it('records a named function into a complete trace with metadata and root output', async () => {
    const trace = await ghost.record(
      'my-flow',
      async function namedFlow() {
        await Promise.resolve();
        return { ok: true, count: 2 };
      },
      { metadata: { env: 'test' } }
    );

    expect(trace).toMatchObject({
      name: 'my-flow',
      version: '1.0.0',
      startTime: 0,
      metadata: {
        name: 'my-flow',
        env: 'test'
      }
    });
    expect(trace.id).toEqual(expect.stringMatching(/^trace_\d{4}$/u));
    expect(trace.endTime).toBeGreaterThan(trace.startTime);
    expect(trace.duration).toBe(trace.endTime - trace.startTime);

    const rootSpan = trace.spans[0];
    expect(rootSpan).toBeDefined();
    if (rootSpan === undefined) {
      throw new Error('expected root span to be present');
    }
    expect(rootSpan).toMatchObject({
      id: 'span_0001',
      parentId: null,
      type: SpanType.Function,
      name: 'namedFlow',
      input: [],
      output: { ok: true, count: 2 },
      error: null
    });
    expect(rootSpan.duration).toBe(rootSpan.endTime - rootSpan.startTime);
  });

  it('captures sync exceptions and async rejections on the root span without skipping teardown', async () => {
    const teardown = vi.fn();
    registerTestInterceptor({
      name: 'teardown-on-error',
      install: () => teardown,
      isAvailable: () => true
    });

    const syncTrace = await ghost.record(
      'sync-error',
      () => {
        throw new TypeError('sync boom');
      },
      { interceptors: ['teardown-on-error'] }
    );
    const asyncTrace = await ghost.record(
      'async-error',
      async () => {
        await Promise.resolve();
        throw new Error('async boom');
      },
      { interceptors: ['teardown-on-error'] }
    );

    expect(syncTrace.spans[0]?.error).toMatchObject({
      name: 'TypeError',
      message: 'sync boom'
    });
    expect(asyncTrace.spans[0]?.error).toMatchObject({
      name: 'Error',
      message: 'async boom'
    });
    expect(teardown).toHaveBeenCalledTimes(2);
  });

  it('calls interceptor teardown exactly once after successful completion', async () => {
    const teardown = vi.fn();
    const install = vi.fn(() => teardown);
    registerTestInterceptor({
      name: 'lifecycle',
      install,
      isAvailable: () => true
    });

    const trace = await ghost.record('lifecycle-flow', () => 'done', {
      interceptors: ['lifecycle']
    });

    expect(trace.spans[0]?.output).toBe('done');
    expect(install).toHaveBeenCalledTimes(1);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('selects interceptors by name and only records spans from selected interceptors', async () => {
    registerTestInterceptor({
      name: 'mock-http',
      install: (context: InterceptorContext) => {
        context.addSpan(spanWithTiming('custom_http', SpanType.Http, 'selected-http', 3, 5));
        return () => undefined;
      },
      isAvailable: () => true
    });
    registerTestInterceptor({
      name: 'mock-fs',
      install: (context: InterceptorContext) => {
        context.addSpan(spanWithTiming('custom_fs', SpanType.Fs, 'unselected-fs', 2, 4));
        return () => undefined;
      },
      isAvailable: () => true
    });

    const trace = await ghost.record('selected-only', () => 'ok', {
      interceptors: ['mock-http']
    });

    expect(trace.spans.map((span) => span.name)).toContain('selected-http');
    expect(trace.spans.map((span) => span.name)).not.toContain('unselected-fs');
  });

  it('captures fetch spans through the built-in http interceptor when explicitly selected', async () => {
    const fetchSpy = vi.fn(async () => new Response('created', { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);

    const trace = await ghost.record(
      'http-selection',
      async () => {
        const response = await fetch('https://example.test/widgets', {
          method: 'POST',
          body: 'payload'
        });
        return response.status;
      },
      { interceptors: ['http'] }
    );

    const httpSpans = trace.spans.filter((span) => span.type === SpanType.Http);
    expect(httpSpans).toHaveLength(1);
    expect(httpSpans[0]).toMatchObject({
      parentId: 'span_0001',
      name: 'fetch',
      input: {
        method: 'POST',
        url: 'https://example.test/widgets',
        body: 'payload'
      },
      output: {
        status: 201,
        body: 'created'
      },
      error: null
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('orders spans chronologically and normalizes every duration from endTime minus startTime', async () => {
    registerTestInterceptor({
      name: 'out-of-order',
      install: (context: InterceptorContext) => {
        context.addSpan({ ...spanWithTiming('late', SpanType.Fs, 'late', 8, 13), duration: 999 });
        context.addSpan({ ...spanWithTiming('early', SpanType.Http, 'early', 2, 4), duration: 999 });
        return () => undefined;
      },
      isAvailable: () => true
    });

    const trace = await ghost.record('ordering', () => 'ok', {
      interceptors: ['out-of-order']
    });

    const startTimes = trace.spans.map((span) => span.startTime);
    expect(startTimes).toEqual([...startTimes].sort((left, right) => left - right));
    expect(trace.spans.every((span) => span.duration === span.endTime - span.startTime)).toBe(true);
  });

  it('enforces trace timing invariants for every span', async () => {
    registerTestInterceptor({
      name: 'outside-bounds',
      install: (context: InterceptorContext) => {
        context.addSpan({ ...spanWithTiming('outside', SpanType.Fs, 'outside', -5, -1), duration: 999 });
        return () => undefined;
      },
      isAvailable: () => true
    });

    const trace = await ghost.record('timing-invariants', () => 'ok', {
      interceptors: ['outside-bounds']
    });
    const allSpans = collectSpans(trace.spans);

    expect(trace.duration).toBe(trace.endTime - trace.startTime);
    expect(allSpans.every((span) => span.duration === span.endTime - span.startTime)).toBe(true);
    expect(allSpans.every((span) => span.startTime >= trace.startTime)).toBe(true);
    expect(allSpans.every((span) => span.endTime <= trace.endTime)).toBe(true);
  });

  it('keeps ten sequential recordings isolated', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => new Response(`body:${String(input)}`));
    vi.stubGlobal('fetch', fetchSpy);

    const traces = [];
    for (let index = 0; index < 10; index += 1) {
      traces.push(
        await ghost.record(
          `sequential-${index}`,
          async () => {
            const response = await fetch(`https://example.test/sequential/${index}`);
            return response.text();
          },
          { interceptors: ['http'] }
        )
      );
    }

    for (let index = 0; index < traces.length; index += 1) {
      const trace = traces[index];
      if (trace === undefined) {
        throw new Error(`missing trace ${index}`);
      }

      expect(trace.name).toBe(`sequential-${index}`);
      expect(trace.metadata.name).toBe(`sequential-${index}`);
      expect(httpUrls(trace.spans)).toEqual([`https://example.test/sequential/${index}`]);
      expect(trace.spans.every((span) => span.metadata.traceName !== `sequential-${index + 1}`)).toBe(true);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('keeps ten parallel recordings isolated while sharing monkey-patched fetch', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => new Response(`body:${String(input)}`));
    vi.stubGlobal('fetch', fetchSpy);

    const traces = await Promise.all(
      Array.from({ length: 10 }, async (_value, index) =>
        ghost.record(
          `parallel-${index}`,
          async () => {
            await Promise.resolve();
            const response = await fetch(`https://example.test/parallel/${index}`);
            return response.text();
          },
          { interceptors: ['http'] }
        )
      )
    );

    for (let index = 0; index < traces.length; index += 1) {
      const trace = traces[index];
      if (trace === undefined) {
        throw new Error(`missing trace ${index}`);
      }

      expect(trace.name).toBe(`parallel-${index}`);
      expect(trace.metadata.name).toBe(`parallel-${index}`);
      expect(httpUrls(trace.spans)).toEqual([`https://example.test/parallel/${index}`]);
      expect(trace.spans.every((span) => span.id.startsWith('span_'))).toBe(true);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('restores monkey-patched globals after a recorded function crashes', async () => {
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const originalRandom = Math.random;
    const originalEnv = process.env;

    const trace = await ghost.record(
      'crash-restores-globals',
      () => {
        expect(globalThis.fetch).not.toBe(originalFetch);
        throw new Error('crashed during recording');
      },
      { interceptors: ['http', 'function', 'fs'] }
    );

    expect(trace.spans[0]?.error).toMatchObject({ message: 'crashed during recording' });
    expect(globalThis.fetch).toBe(originalFetch);
    expect(Date.now).toBe(originalDateNow);
    expect(Math.random).toBe(originalRandom);
    expect(process.env).toBe(originalEnv);
  });

  it('captures broken interceptor failures as error spans and still completes recording', async () => {
    registerTestInterceptor({
      name: 'broken',
      install: () => {
        throw new Error('install exploded');
      },
      isAvailable: () => true
    });

    const trace = await ghost.record('broken-interceptor', () => 42, {
      interceptors: ['broken']
    });

    expect(trace.spans[0]?.output).toBe(42);
    expect(trace.spans.some((span) => span.type === SpanType.Error && span.error?.message === 'install exploded')).toBe(
      true
    );
  });
});
