import { getTraceContext, runWithSpanContext } from '../core/context.js';
import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanError } from '../core/types.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';

const HTTP_SENTINEL = '__GHOSTTRACE_HTTP_INTERCEPTOR_SENTINEL__';

function markHttpInterceptorBundled(): string {
  return HTTP_SENTINEL;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }

  return headersToRecord(new Headers(headers));
}

function bodyPreview(body: BodyInit | null | undefined): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof ArrayBuffer) {
    return {
      type: 'ArrayBuffer',
      byteLength: body.byteLength
    };
  }
  if (ArrayBuffer.isView(body)) {
    return {
      type: body.constructor.name,
      byteLength: body.byteLength
    };
  }

  return Object.prototype.toString.call(body);
}

function fetchInputDetails(input: RequestInfo | URL, init: RequestInit | undefined): Record<string, unknown> {
  const request = typeof Request === 'undefined' ? undefined : input instanceof Request ? input : undefined;
  const initHeaders = normalizeHeaders(init?.headers);
  const requestHeaders = request === undefined ? {} : headersToRecord(request.headers);
  const method = init?.method ?? request?.method ?? 'GET';
  const url = request?.url ?? String(input);
  const body = init?.body ?? null;

  return {
    method,
    url,
    headers: {
      ...requestHeaders,
      ...initHeaders
    },
    body: bodyPreview(body)
  };
}

async function responseOutput(response: Response): Promise<Record<string, unknown>> {
  const baseOutput: Record<string, unknown> = {
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers)
  };

  try {
    return {
      ...baseOutput,
      body: await response.clone().text()
    };
  } catch (error) {
    return {
      ...baseOutput,
      body: {
        unavailable: true,
        reason: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function spanErrorFromUnknown(error: unknown): SpanError {
  if (error instanceof Error) {
    const spanError: {
      name: string;
      message: string;
      stack?: string;
    } = {
      name: error.name,
      message: error.message
    };

    if (error.stack !== undefined) {
      spanError.stack = error.stack;
    }

    return spanError;
  }

  return {
    name: error === null ? 'null' : typeof error,
    message: String(error)
  };
}

function pendingHttpSpan(input: unknown): Span | undefined {
  const context = getTraceContext();

  if (context === undefined || context.mode !== 'record') {
    return undefined;
  }

  const startTime = context.clock.now();

  return {
    id: context.idGenerator.next(),
    parentId: context.currentSpan?.id ?? null,
    type: SpanType.Http,
    name: 'fetch',
    startTime,
    endTime: startTime,
    duration: 0,
    input: serialize(input),
    output: serialize(undefined),
    children: [],
    error: null,
    metadata: {}
  };
}

function completeHttpSpan(span: Span, output: unknown, error: SpanError | null): Span {
  const context = getTraceContext();
  const endTime = context?.clock.now() ?? span.startTime;

  return {
    ...span,
    endTime,
    duration: endTime - span.startTime,
    output: serialize(output),
    error,
    children: []
  };
}

/** HTTP interceptor that records fetch calls during an active recording context. */
export const httpInterceptor: Interceptor = {
  name: 'http',
  install: (context: InterceptorContext): Teardown => {
    void markHttpInterceptorBundled();
    const originalFetch = globalThis.fetch;
    const patchedFetch: typeof globalThis.fetch = async (input, init) => {
      const span = pendingHttpSpan(fetchInputDetails(input, init));

      if (span === undefined) {
        return originalFetch(input, init);
      }

      try {
        const response = await runWithSpanContext(span, () => originalFetch(input, init));
        context.addSpan(completeHttpSpan(span, await responseOutput(response), null));
        return response;
      } catch (error) {
        context.addSpan(completeHttpSpan(span, undefined, spanErrorFromUnknown(error)));
        throw error;
      }
    };

    globalThis.fetch = patchedFetch;

    return () => {
      if (globalThis.fetch === patchedFetch) {
        globalThis.fetch = originalFetch;
      }
    };
  },
  isAvailable: (): boolean => typeof globalThis.fetch === 'function'
};
