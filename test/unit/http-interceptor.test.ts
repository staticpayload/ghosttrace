import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpanType, ghost, type Span } from '../../src/index.js';

interface Deferred<TValue> {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue | PromiseLike<TValue>) => void;
  readonly reject: (reason?: unknown) => void;
}

function createDeferred<TValue = void>(): Deferred<TValue> {
  let resolve: Deferred<TValue>['resolve'];
  let reject: Deferred<TValue>['reject'];
  const promise = new Promise<TValue>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    resolve: resolve!,
    reject: reject!
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fetchUrls(spans: readonly Span[]): readonly string[] {
  return spans.flatMap((span) => {
    if (span.type !== SpanType.Http || !isRecord(span.input) || typeof span.input.url !== 'string') {
      return [];
    }

    return [span.input.url];
  });
}

describe('HTTP interceptor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shares one fetch patch across overlapping recordings and restores only after the last teardown', async () => {
    const originalFetch = vi.fn(async (input: RequestInfo | URL) => new Response(`body:${String(input)}`));
    vi.stubGlobal('fetch', originalFetch);
    const trueOriginalFetch = globalThis.fetch;
    const firstInstalled = createDeferred();
    const firstMayComplete = createDeferred();
    const firstCompleted = createDeferred();
    const secondInstalled = createDeferred();
    let firstSharedFetch: typeof globalThis.fetch | undefined;
    let secondSharedFetch: typeof globalThis.fetch | undefined;

    const firstTracePromise = ghost.record(
      'overlap-first',
      async () => {
        firstSharedFetch = globalThis.fetch;
        firstInstalled.resolve();
        expect(firstSharedFetch).not.toBe(trueOriginalFetch);

        const response = await fetch('https://example.test/overlap/first');
        await firstMayComplete.promise;
        return response.text();
      },
      { interceptors: ['http'] }
    );

    await firstInstalled.promise;

    const secondTracePromise = ghost.record(
      'overlap-second',
      async () => {
        secondSharedFetch = globalThis.fetch;
        secondInstalled.resolve();
        expect(secondSharedFetch).toBe(firstSharedFetch);

        await firstCompleted.promise;
        expect(globalThis.fetch).toBe(secondSharedFetch);

        const response = await fetch('https://example.test/overlap/second');
        return response.text();
      },
      { interceptors: ['http'] }
    );

    await secondInstalled.promise;
    expect(globalThis.fetch).toBe(firstSharedFetch);

    firstMayComplete.resolve();
    const firstTrace = await firstTracePromise;
    firstCompleted.resolve();

    expect(globalThis.fetch).toBe(secondSharedFetch);

    const secondTrace = await secondTracePromise;

    expect(globalThis.fetch).toBe(trueOriginalFetch);
    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(fetchUrls(firstTrace.spans)).toEqual(['https://example.test/overlap/first']);
    expect(fetchUrls(secondTrace.spans)).toEqual(['https://example.test/overlap/second']);
  });
});
