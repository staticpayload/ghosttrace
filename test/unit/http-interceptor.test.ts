import * as http from 'node:http';
import * as https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpanType, deserialize, ghost, type SerializedJsonValue, type Span } from '../../src/index.js';

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

function httpSpans(spans: readonly Span[]): readonly Span[] {
  return spans.filter((span) => span.type === SpanType.Http);
}

function deserializeAs<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a record`);
  }

  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readIncomingRequest(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.once('end', () => resolve(body));
    request.once('error', reject);
  });
}

function listenOnEphemeralPort(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not expose a TCP port'));
        return;
      }

      resolve(address.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

interface RequestTextOptions {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

interface StreamingRequestInit extends RequestInit {
  readonly duplex: 'half';
}

function requestText(url: string, options: RequestTextOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: options.method,
        headers: options.headers
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.once('end', () => resolve(body));
        response.once('error', reject);
      }
    );

    request.once('error', reject);
    if (options.timeoutMs !== undefined) {
      request.setTimeout(options.timeoutMs, () => {
        request.destroy(new Error('request timed out'));
      });
    }
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
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

  it('captures fetch request and response details while preserving json and blob readers', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        statusText: 'Created',
        headers: {
          'content-type': 'application/json',
          'x-response': 'yes'
        }
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const trace = await ghost.record(
      'fetch-details',
      async () => {
        const jsonResponse = await fetch('https://api.example.test/widgets?kind=all', {
          method: 'POST',
          headers: {
            'x-api-key': 'test-key'
          },
          body: 'payload'
        });
        const json = (await jsonResponse.json()) as { readonly ok: boolean };

        const blobResponse = await fetch('https://api.example.test/blob');
        const blob = await blobResponse.blob();

        return {
          ok: json.ok,
          blobSize: blob.size
        };
      },
      { interceptors: ['http'] }
    );

    const spans = httpSpans(trace.spans);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      parentId: 'span_0001',
      name: 'fetch',
      input: {
        method: 'POST',
        url: 'https://api.example.test/widgets?kind=all',
        headers: {
          'x-api-key': 'test-key'
        },
        body: 'payload'
      },
      output: {
        status: 201,
        statusText: 'Created',
        headers: {
          'content-type': 'application/json',
          'x-response': 'yes'
        },
        body: '{"ok":true}'
      },
      error: null
    });
    expect(trace.spans[0]?.output).toEqual({
      ok: true,
      blobSize: '{"ok":true}'.length
    });
  });

  it('captures Request object method URL headers and body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('accepted', { status: 202 })));

    const trace = await ghost.record(
      'request-object',
      async () => {
        const request = new Request('https://api.example.test/request-object?mode=put', {
          method: 'PUT',
          headers: {
            'x-request-object': 'yes'
          },
          body: 'request-body'
        });
        const response = await fetch(request);
        return response.text();
      },
      { interceptors: ['http'] }
    );

    const span = httpSpans(trace.spans)[0];
    expect(span).toMatchObject({
      input: {
        method: 'PUT',
        url: 'https://api.example.test/request-object?mode=put',
        headers: {
          'x-request-object': 'yes'
        },
        body: 'request-body'
      },
      output: {
        status: 202,
        body: 'accepted'
      },
      error: null
    });
  });

  it('replays fetch responses without live network access and restores the fetch stub after replay errors', async () => {
    const recordedFetch = vi.fn(async () =>
      new Response(JSON.stringify({ source: 'recorded' }), {
        status: 203,
        statusText: 'Non-Authoritative Information',
        headers: {
          'content-type': 'application/json',
          'x-replayed': 'yes'
        }
      })
    );
    vi.stubGlobal('fetch', recordedFetch);

    const trace = await ghost.record(
      'fetch-replay-without-network',
      async () => {
        const response = await fetch('https://api.example.test/replay', {
          method: 'POST',
          headers: {
            'x-request': 'recorded'
          },
          body: 'recorded-body'
        });
        const json = (await response.json()) as { readonly source: string };

        return {
          status: response.status,
          statusText: response.statusText,
          replayedHeader: response.headers.get('x-replayed'),
          json
        };
      },
      { interceptors: ['http'] }
    );
    const blockedFetch = vi.fn(async () => {
      throw new Error('live network should not be called during replay');
    });
    vi.stubGlobal('fetch', blockedFetch);
    const fetchBeforeReplay = globalThis.fetch;
    const expectedOutput = deserializeAs(trace.spans[0]?.output);

    const replayed = await ghost.replay(trace, async () => {
      expect(globalThis.fetch).not.toBe(fetchBeforeReplay);
      const response = await fetch('https://api.example.test/replay', {
        method: 'POST',
        headers: {
          'x-request': 'recorded'
        },
        body: 'recorded-body'
      });
      const json = (await response.json()) as { readonly source: string };

      return {
        status: response.status,
        statusText: response.statusText,
        replayedHeader: response.headers.get('x-replayed'),
        json
      };
    });

    expect(replayed.output).toEqual(expectedOutput);
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual(['fetch']);
    expect(blockedFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(fetchBeforeReplay);

    await expect(
      ghost.replay(trace, async () => {
        await fetch('https://api.example.test/replay', {
          method: 'POST',
          headers: {
            'x-request': 'recorded'
          },
          body: 'recorded-body'
        });
        throw new Error('user replay failure');
      })
    ).rejects.toThrow('user replay failure');
    expect(blockedFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(fetchBeforeReplay);
  });

  it('dispatches fetch with a streaming Request body before the body closes and still captures the body', async () => {
    const encoder = new TextEncoder();
    const controllerReady = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
    const fetchCalled = createDeferred<void>();
    const fetchSpy = vi.fn<typeof fetch>(async (input, init) => {
      fetchCalled.resolve();
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.text();
      return new Response(`echo:${body}`, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    let dispatchedBeforeBodyClosed = false;

    const trace = await ghost.record(
      'streaming-request-body-lazy',
      async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('first'));
            controllerReady.resolve(controller);
          }
        });
        const requestInit: StreamingRequestInit = {
          method: 'POST',
          headers: {
            'content-type': 'text/plain'
          },
          body: stream,
          duplex: 'half'
        };
        const request = new Request('https://api.example.test/streaming-request-body', requestInit);
        const responsePromise = fetch(request);
        const dispatchResult = await Promise.race([
          fetchCalled.promise.then(() => 'called' as const),
          delay(25).then(() => 'timeout' as const)
        ]);

        dispatchedBeforeBodyClosed = dispatchResult === 'called';
        const controller = await controllerReady.promise;
        controller.enqueue(encoder.encode('second'));
        controller.close();

        const response = await responsePromise;
        return response.text();
      },
      { interceptors: ['http'] }
    );

    expect(dispatchedBeforeBodyClosed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(trace.spans[0]?.output).toBe('echo:firstsecond');
    const span = httpSpans(trace.spans)[0];
    expect(span).toMatchObject({
      input: {
        method: 'POST',
        url: 'https://api.example.test/streaming-request-body',
        headers: {
          'content-type': 'text/plain'
        },
        body: 'firstsecond'
      },
      output: {
        status: 200,
        body: 'echo:firstsecond'
      },
      error: null
    });
  });

  it('truncates oversized fetch response bodies with explicit size metadata', async () => {
    const largeBody = 'x'.repeat(10 * 1024 * 1024);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(largeBody, {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': String(largeBody.length)
          }
        })
      )
    );

    const trace = await ghost.record(
      'fetch-large-response',
      async () => {
        const response = await fetch('https://api.example.test/large');
        await response.text();
        return response.status;
      },
      { interceptors: ['http'] }
    );

    const span = httpSpans(trace.spans)[0];
    const output = requireRecord(span?.output, 'span.output');
    const body = requireRecord(output.body, 'span.output.body');
    const text = requireString(body.text, 'span.output.body.text');
    expect(body.truncated).toBe(true);
    expect(body.limitBytes).toBe(1024 * 1024);
    expect(body.byteLength).toBe(largeBody.length);
    expect(text.length).toBeLessThan(largeBody.length);
  });

  it('returns streaming fetch responses before the body closes and captures direct body consumption lazily', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const controllerReady = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
    const fetchSpy = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('hello '));
            controllerReady.resolve(controller);
          }
        }),
        {
          headers: {
            'content-type': 'text/plain'
          }
        }
      )
    );
    vi.stubGlobal('fetch', fetchSpy);

    const trace = await ghost.record(
      'fetch-lazy-streaming',
      async () => {
        const responsePromise = fetch('https://api.example.test/lazy-stream');
        const result = await Promise.race([
          responsePromise.then((response) => ({ kind: 'response' as const, response })),
          delay(25).then(() => ({ kind: 'timeout' as const }))
        ]);

        if (result.kind === 'timeout') {
          const controller = await controllerReady.promise;
          controller.close();
        }

        expect(result.kind).toBe('response');
        if (result.kind !== 'response') {
          return 'timed-out';
        }

        expect(result.response.body).not.toBeNull();
        const reader = result.response.body!.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);

        const controller = await controllerReady.promise;
        controller.enqueue(encoder.encode('stream'));
        controller.close();

        const second = await reader.read();
        const done = await reader.read();
        reader.releaseLock();

        return `${decoder.decode(first.value)}${decoder.decode(second.value)}:${String(done.done)}`;
      },
      { interceptors: ['http'] }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(trace.spans[0]?.output).toBe('hello stream:true');
    const span = httpSpans(trace.spans)[0];
    expect(span).toMatchObject({
      input: {
        url: 'https://api.example.test/lazy-stream'
      },
      output: {
        status: 200,
        headers: {
          'content-type': 'text/plain'
        },
        body: 'hello stream'
      },
      error: null
    });
  });

  it('records fetch network errors, aborts, timeouts, and streaming response bodies', async () => {
    const encoder = new TextEncoder();
    const networkError = new TypeError('network down');
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    const timeoutError = new DOMException('The operation timed out', 'TimeoutError');
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(abortError)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('hello '));
              controller.enqueue(encoder.encode('stream'));
              controller.close();
            }
          })
        )
      );
    vi.stubGlobal('fetch', fetchSpy);

    const trace = await ghost.record(
      'fetch-errors-and-streaming',
      async () => {
        for (const url of [
          'https://api.example.test/network',
          'https://api.example.test/abort',
          'https://api.example.test/timeout'
        ]) {
          try {
            await fetch(url);
          } catch {
            // Expected: the interceptor should record and rethrow each original error.
          }
        }

        const response = await fetch('https://api.example.test/stream');
        return response.text();
      },
      { interceptors: ['http'] }
    );

    const spans = httpSpans(trace.spans);
    expect(spans).toHaveLength(4);
    expect(spans[0]?.error).toMatchObject({ name: 'TypeError', message: 'network down' });
    expect(spans[1]?.error).toMatchObject({ name: 'AbortError' });
    expect(spans[2]?.error).toMatchObject({ name: 'TimeoutError' });
    expect(spans[3]).toMatchObject({
      output: {
        body: 'hello stream'
      },
      error: null
    });
    expect(trace.spans[0]?.output).toBe('hello stream');
  });

  it('patches and restores node http and https request while capturing request and response details', async () => {
    const originalHttpRequest = http.request;
    const originalHttpsRequest = https.request;
    const server = http.createServer(async (request, response) => {
      const body = await readIncomingRequest(request);
      response.writeHead(202, {
        'content-type': 'text/plain',
        'x-node-response': 'yes'
      });
      response.end(`echo:${body}`);
    });

    try {
      const port = await listenOnEphemeralPort(server);
      const url = `http://127.0.0.1:${port}/node?query=yes`;
      const trace = await ghost.record(
        'node-request',
        async () => {
          expect(http.request).not.toBe(originalHttpRequest);
          expect(https.request).not.toBe(originalHttpsRequest);
          return requestText(url, {
            method: 'POST',
            headers: {
              'x-node-input': 'yes'
            },
            body: 'node-body'
          });
        },
        { interceptors: ['http'] }
      );

      expect(http.request).toBe(originalHttpRequest);
      expect(https.request).toBe(originalHttpsRequest);
      expect(trace.spans[0]?.output).toBe('echo:node-body');

      const span = httpSpans(trace.spans)[0];
      expect(span).toMatchObject({
        name: 'http.request',
        input: {
          method: 'POST',
          url,
          headers: {
            'x-node-input': 'yes'
          },
          body: 'node-body'
        },
        output: {
          status: 202,
          headers: {
            'content-type': 'text/plain',
            'x-node-response': 'yes'
          },
          body: 'echo:node-body'
        },
        error: null
      });
    } finally {
      await closeServer(server);
    }
  });

  it('replays node http.request responses without contacting the recorded server', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(209, {
        'content-type': 'text/plain',
        'x-node-replay': 'yes'
      });
      response.end('node-recorded-body');
    });

    const port = await listenOnEphemeralPort(server);
    const url = `http://127.0.0.1:${port}/node-replay`;
    const trace = await ghost.record('node-request-replay', () => requestText(url), {
      interceptors: ['http']
    });
    await closeServer(server);

    const replayed = await ghost.replay(trace, () => requestText(url));

    expect(replayed.output).toBe('node-recorded-body');
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual(['http.request']);
  });

  it('records node http request timeouts as errored HTTP spans', async () => {
    const server = http.createServer(() => {
      // Intentionally leave the request open until the client timeout fires.
    });

    try {
      const port = await listenOnEphemeralPort(server);
      const trace = await ghost.record(
        'node-request-timeout',
        async () => {
          try {
            await requestText(`http://127.0.0.1:${port}/timeout`, { timeoutMs: 10 });
          } catch {
            return 'timed-out';
          }

          return 'unexpected-success';
        },
        { interceptors: ['http'] }
      );

      const span = httpSpans(trace.spans)[0];
      expect(trace.spans[0]?.output).toBe('timed-out');
      expect(span).toMatchObject({
        name: 'http.request',
        error: {
          name: 'TimeoutError'
        }
      });
    } finally {
      await closeServer(server);
    }
  });
});
