import { Buffer } from 'node:buffer';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  RequestOptions
} from 'node:http';
import { getTraceContext, runWithSpanContext, type TraceContext } from '../core/context.js';
import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanError } from '../core/types.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';

const HTTP_SENTINEL = '__GHOSTTRACE_HTTP_INTERCEPTOR_SENTINEL__';
const MAX_CAPTURE_BYTES = 1024 * 1024;

type HttpRequestFunction = typeof import('node:http').request;
type HttpsRequestFunction = typeof import('node:https').request;
type NodeRequestFunction = HttpRequestFunction | HttpsRequestFunction;
type RequestProtocol = 'http:' | 'https:';

interface MutableHttpModule {
  request: HttpRequestFunction;
}

interface MutableHttpsModule {
  request: HttpsRequestFunction;
}

interface ActiveHttpSession {
  readonly addSpan: (span: Span) => void;
}

interface ActiveHttpContext {
  readonly context: TraceContext;
  readonly session: ActiveHttpSession;
}

interface MutableSpanError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SpanError;
}

interface BodyAccumulator {
  readonly chunks: Buffer[];
  byteLength: number;
  capturedBytes: number;
  truncated: boolean;
  hasBody: boolean;
}

interface TruncatedBodyRecord {
  readonly text: string;
  readonly truncated: true;
  readonly byteLength: number;
  readonly capturedBytes: number;
  readonly limitBytes: number;
}

interface BodyUnavailableRecord {
  readonly unavailable: true;
  readonly reason: string;
}

interface BodyMarkerRecord {
  readonly type: string;
  readonly byteLength?: number;
  readonly size?: number;
  readonly contentType?: string;
}

interface NodeRequestDetails {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: unknown;
}

interface MutableClientRequestMethods {
  write: (this: ClientRequest, ...args: unknown[]) => boolean;
  end: (this: ClientRequest, ...args: unknown[]) => ClientRequest;
}

interface MutableIncomingMessage extends IncomingMessage {
  emit: (this: IncomingMessage, eventName: string | symbol, ...args: unknown[]) => boolean;
}

const requireNodeModule = createRequire(import.meta.url);
const nodeHttp = requireNodeModule('node:http') as MutableHttpModule;
const nodeHttps = requireNodeModule('node:https') as MutableHttpsModule;

const activeHttpSessions = new Map<string, ActiveHttpSession>();
let originalFetch: typeof globalThis.fetch | undefined;
let patchedFetch: typeof globalThis.fetch | undefined;
let originalHttpRequest: HttpRequestFunction | undefined;
let patchedHttpRequest: HttpRequestFunction | undefined;
let originalHttpsRequest: HttpsRequestFunction | undefined;
let patchedHttpsRequest: HttpsRequestFunction | undefined;

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

function createBodyAccumulator(): BodyAccumulator {
  return {
    chunks: [],
    byteLength: 0,
    capturedBytes: 0,
    truncated: false,
    hasBody: false
  };
}

function appendBodyChunk(accumulator: BodyAccumulator, chunk: Buffer): void {
  accumulator.hasBody = true;
  accumulator.byteLength += chunk.byteLength;

  if (accumulator.capturedBytes < MAX_CAPTURE_BYTES) {
    const remainingBytes = MAX_CAPTURE_BYTES - accumulator.capturedBytes;
    const capturedChunk = chunk.byteLength <= remainingBytes ? chunk : chunk.subarray(0, remainingBytes);
    accumulator.chunks.push(capturedChunk);
    accumulator.capturedBytes += capturedChunk.byteLength;
  }

  if (accumulator.byteLength > MAX_CAPTURE_BYTES) {
    accumulator.truncated = true;
  }
}

function finalizeBodyAccumulator(accumulator: BodyAccumulator, reportedByteLength?: number): unknown {
  if (!accumulator.hasBody) {
    return undefined;
  }

  const byteLength = Math.max(accumulator.byteLength, reportedByteLength ?? 0);
  const text = Buffer.concat(accumulator.chunks, accumulator.capturedBytes).toString('utf8');

  if (!accumulator.truncated && byteLength <= MAX_CAPTURE_BYTES) {
    return text;
  }

  return {
    text,
    truncated: true,
    byteLength,
    capturedBytes: accumulator.capturedBytes,
    limitBytes: MAX_CAPTURE_BYTES
  } satisfies TruncatedBodyRecord;
}

function captureBufferBody(buffer: Buffer, reportedByteLength?: number): unknown {
  const accumulator = createBodyAccumulator();
  appendBodyChunk(accumulator, buffer);
  return finalizeBodyAccumulator(accumulator, reportedByteLength);
}

function captureStringBody(body: string): unknown {
  return captureBufferBody(Buffer.from(body, 'utf8'));
}

function bodyUnavailable(error: unknown): BodyUnavailableRecord {
  return {
    unavailable: true,
    reason: error instanceof Error ? error.message : String(error)
  };
}

function contentLengthFromHeaders(headers: Headers): number | undefined {
  const contentLength = headers.get('content-length');
  if (contentLength === null) {
    return undefined;
  }

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function byteLengthFromIncomingHeaders(headers: IncomingHttpHeaders): number | undefined {
  const value = headers['content-length'];
  const firstValue = Array.isArray(value) ? value[0] : value;
  if (firstValue === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(firstValue, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

async function captureReadableStreamBody(
  stream: ReadableStream<Uint8Array> | null,
  reportedByteLength?: number
): Promise<unknown> {
  if (stream === null) {
    return undefined;
  }

  const accumulator = createBodyAccumulator();
  const reader = stream.getReader();

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      appendBodyChunk(accumulator, Buffer.from(result.value));
      if (accumulator.truncated) {
        void reader.cancel('GhostTrace body capture limit reached');
        break;
      }
    }

    return finalizeBodyAccumulator(accumulator, reportedByteLength);
  } catch (error) {
    return bodyUnavailable(error);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some runtimes throw when the stream has already been released or cancelled.
    }
  }
}

function formDataBodyPreview(body: FormData): unknown {
  const fields: Array<Readonly<Record<string, unknown>>> = [];

  for (const [name, value] of body.entries()) {
    if (typeof value === 'string') {
      fields.push({ name, value: captureStringBody(value) });
      continue;
    }

    fields.push({
      name,
      value: {
        type: value.constructor.name,
        size: value.size,
        contentType: value.type
      } satisfies BodyMarkerRecord
    });
  }

  return fields;
}

async function captureBlobBody(body: Blob): Promise<unknown> {
  const slice = body.slice(0, MAX_CAPTURE_BYTES + 1);
  try {
    return captureBufferBody(Buffer.from(await slice.arrayBuffer()), body.size);
  } catch (error) {
    return bodyUnavailable(error);
  }
}

async function captureBodyInit(body: BodyInit | null | undefined): Promise<unknown> {
  if (body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return captureStringBody(body);
  }
  if (body instanceof URLSearchParams) {
    return captureStringBody(body.toString());
  }
  if (body instanceof ArrayBuffer) {
    return captureBufferBody(Buffer.from(body));
  }
  if (ArrayBuffer.isView(body)) {
    return captureBufferBody(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return captureBlobBody(body);
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return formDataBodyPreview(body);
  }
  if (isReadableStream(body)) {
    return {
      type: 'ReadableStream',
      reason: 'stream body capture is unavailable without consuming the live request body'
    };
  }

  return Object.prototype.toString.call(body);
}

async function captureRequestObjectBody(request: Request): Promise<unknown> {
  if (request.body === null || request.bodyUsed) {
    return undefined;
  }

  try {
    const clone = request.clone();
    return await captureReadableStreamBody(clone.body, contentLengthFromHeaders(clone.headers));
  } catch (error) {
    return bodyUnavailable(error);
  }
}

async function fetchInputDetails(input: RequestInfo | URL, init: RequestInit | undefined): Promise<Record<string, unknown>> {
  const request = typeof Request === 'undefined' ? undefined : input instanceof Request ? input : undefined;
  const initHeaders = normalizeHeaders(init?.headers);
  const requestHeaders = request === undefined ? {} : headersToRecord(request.headers);
  const method = init?.method ?? request?.method ?? 'GET';
  const url = request?.url ?? String(input);
  const body = init !== undefined && 'body' in init ? await captureBodyInit(init.body) : await (request === undefined ? Promise.resolve(undefined) : captureRequestObjectBody(request));

  return {
    method,
    url,
    headers: {
      ...requestHeaders,
      ...initHeaders
    },
    body
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
      body: await captureReadableStreamBody(response.clone().body, contentLengthFromHeaders(response.headers))
    };
  } catch (error) {
    return {
      ...baseOutput,
      body: bodyUnavailable(error)
    };
  }
}

function spanErrorFromUnknown(error: unknown): SpanError {
  if (error instanceof Error) {
    const errorRecord = error as Error & {
      readonly cause?: unknown;
      readonly code?: unknown;
    };
    const spanError: MutableSpanError = {
      name: error.name,
      message: error.message
    };

    if (error.stack !== undefined) {
      spanError.stack = error.stack;
    }
    if (typeof errorRecord.code === 'string') {
      spanError.code = errorRecord.code;
    }
    if (errorRecord.cause !== undefined) {
      spanError.cause = spanErrorFromUnknown(errorRecord.cause);
    }

    return spanError;
  }

  return {
    name: error === null ? 'null' : typeof error,
    message: String(error)
  };
}

function timeoutSpanError(message: string): SpanError {
  return {
    name: 'TimeoutError',
    message
  };
}

function abortSpanError(message: string): SpanError {
  return {
    name: 'AbortError',
    message
  };
}

function activeHttpContext(): ActiveHttpContext | undefined {
  const context = getTraceContext();

  if (context === undefined || context.mode !== 'record') {
    return undefined;
  }

  const session = activeHttpSessions.get(context.traceId);
  if (session === undefined) {
    return undefined;
  }

  return { context, session };
}

function pendingHttpSpan(context: TraceContext, name: string, input: unknown): Span {
  const startTime = context.clock.now();

  return {
    id: context.idGenerator.next(),
    parentId: context.currentSpan?.id ?? null,
    type: SpanType.Http,
    name,
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

function completeHttpSpan(
  context: TraceContext,
  span: Span,
  input: unknown,
  output: unknown,
  error: SpanError | null
): Span {
  const endTime = context.clock.now();

  return {
    ...span,
    endTime,
    duration: endTime - span.startTime,
    input: serialize(input),
    output: serialize(output),
    error,
    children: []
  };
}

function fetchImplementation(): typeof globalThis.fetch {
  if (originalFetch === undefined) {
    throw new TypeError('fetch is not available');
  }

  return originalFetch;
}

function fetchAvailable(): boolean {
  return typeof globalThis.fetch === 'function';
}

function installGlobalFetchPatch(): void {
  if (patchedFetch !== undefined || !fetchAvailable()) {
    return;
  }

  originalFetch = globalThis.fetch;
  patchedFetch = async (input, init) => {
    const active = activeHttpContext();
    const fetch = fetchImplementation();

    if (active === undefined) {
      return fetch(input, init);
    }

    const inputDetails = await fetchInputDetails(input, init);
    const span = pendingHttpSpan(active.context, 'fetch', inputDetails);

    try {
      const response = await runWithSpanContext(span, () => fetch(input, init));
      active.session.addSpan(completeHttpSpan(active.context, span, inputDetails, await responseOutput(response), null));
      return response;
    } catch (error) {
      active.session.addSpan(completeHttpSpan(active.context, span, inputDetails, undefined, spanErrorFromUnknown(error)));
      throw error;
    }
  };

  globalThis.fetch = patchedFetch;
}

function normalizeHeaderValue(value: string | number | readonly string[]): string | readonly string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  return String(value);
}

function normalizeNodeRequestHeaders(
  headers: OutgoingHttpHeaders | readonly string[] | undefined
): Record<string, string | readonly string[]> {
  const record: Record<string, string | readonly string[]> = {};
  if (headers === undefined) {
    return record;
  }

  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      const key = headers[index];
      const value = headers[index + 1];
      if (key === undefined || value === undefined) {
        continue;
      }

      record[String(key).toLowerCase()] = String(value);
    }

    return record;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    record[key.toLowerCase()] = normalizeHeaderValue(value);
  }

  return record;
}

function normalizeIncomingHeaders(headers: IncomingHttpHeaders): Record<string, string | readonly string[]> {
  const record: Record<string, string | readonly string[]> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    record[key.toLowerCase()] = Array.isArray(value) ? value.map((item) => String(item)) : String(value);
  }

  return record;
}

function requestOptionString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function normalizedProtocol(protocol: string | undefined, fallback: RequestProtocol): string {
  const selectedProtocol = protocol ?? fallback;
  return selectedProtocol.endsWith(':') ? selectedProtocol : `${selectedProtocol}:`;
}

function isRequestOptions(value: unknown): value is RequestOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof URL) &&
    !(value instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(value)
  );
}

function requestOptionsFromArgs(args: readonly unknown[]): RequestOptions {
  for (const arg of args) {
    if (isRequestOptions(arg)) {
      return arg;
    }
  }

  return {};
}

function baseUrlFromArgs(args: readonly unknown[]): URL | undefined {
  const firstArg = args[0];
  if (firstArg instanceof URL) {
    return firstArg;
  }
  if (typeof firstArg === 'string') {
    try {
      return new URL(firstArg);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function requestUrlFromDetails(protocol: RequestProtocol, args: readonly unknown[], options: RequestOptions): string {
  const baseUrl = baseUrlFromArgs(args);
  const optionsRecord = options as Readonly<Record<string, unknown>>;
  const optionHost = requestOptionString(optionsRecord.host);
  const optionHostname = requestOptionString(optionsRecord.hostname);
  const hostCameFromHost = optionHostname === undefined && optionHost !== undefined;
  const resolvedProtocol = normalizedProtocol(requestOptionString(optionsRecord.protocol) ?? baseUrl?.protocol, protocol);
  const hostname = optionHostname ?? optionHost ?? baseUrl?.hostname ?? 'localhost';
  const port = requestOptionString(optionsRecord.port) ?? (hostCameFromHost ? undefined : baseUrl?.port);
  const pathname = requestOptionString(optionsRecord.pathname) ?? baseUrl?.pathname ?? '/';
  const search = requestOptionString(optionsRecord.search) ?? baseUrl?.search ?? '';
  const path = requestOptionString(optionsRecord.path) ?? `${pathname}${search}`;
  const base = port === undefined || port.length === 0 ? `${resolvedProtocol}//${hostname}` : `${resolvedProtocol}//${hostname}:${port}`;

  try {
    return new URL(path, base).toString();
  } catch {
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

function nodeRequestDetails(protocol: RequestProtocol, args: readonly unknown[]): NodeRequestDetails {
  const options = requestOptionsFromArgs(args);
  const method = requestOptionString((options as Readonly<Record<string, unknown>>).method)?.toUpperCase() ?? 'GET';
  const details = {
    method,
    url: requestUrlFromDetails(protocol, args, options),
    headers: normalizeNodeRequestHeaders(options.headers)
  };

  return details;
}

function isBufferEncoding(value: unknown): value is BufferEncoding {
  return typeof value === 'string' && Buffer.isEncoding(value);
}

function nodeChunkToBuffer(chunk: unknown, encoding: unknown): Buffer | undefined {
  if (chunk === undefined || typeof chunk === 'function') {
    return undefined;
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, isBufferEncoding(encoding) ? encoding : 'utf8');
  }
  if (Buffer.isBuffer(chunk)) {
    return Buffer.from(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  return undefined;
}

function captureNodeRequestChunk(accumulator: BodyAccumulator, args: readonly unknown[]): void {
  const buffer = nodeChunkToBuffer(args[0], args[1]);
  if (buffer === undefined) {
    return;
  }

  appendBodyChunk(accumulator, buffer);
}

function outputFromIncomingMessage(response: IncomingMessage, accumulator: BodyAccumulator): Record<string, unknown> {
  return {
    status: response.statusCode,
    statusMessage: response.statusMessage,
    headers: normalizeIncomingHeaders(response.headers),
    body: finalizeBodyAccumulator(accumulator, byteLengthFromIncomingHeaders(response.headers))
  };
}

function patchIncomingMessage(
  response: IncomingMessage,
  complete: (output: unknown, error: SpanError | null) => void
): void {
  const accumulator = createBodyAccumulator();
  const mutableResponse = response as MutableIncomingMessage;
  const originalEmit = response.emit as (this: IncomingMessage, eventName: string | symbol, ...args: unknown[]) => boolean;

  mutableResponse.emit = function ghosttraceResponseEmit(
    this: IncomingMessage,
    eventName: string | symbol,
    ...eventArgs: unknown[]
  ): boolean {
    if (eventName === 'data') {
      captureNodeRequestChunk(accumulator, eventArgs);
    }

    const emitted = originalEmit.call(this, eventName, ...eventArgs);

    if (eventName === 'end') {
      complete(outputFromIncomingMessage(response, accumulator), null);
    } else if (eventName === 'error') {
      complete(outputFromIncomingMessage(response, accumulator), spanErrorFromUnknown(eventArgs[0]));
    } else if (eventName === 'close' && response.complete) {
      complete(outputFromIncomingMessage(response, accumulator), null);
    }

    return emitted;
  };
}

function callNodeRequest(original: NodeRequestFunction, target: object, args: readonly unknown[]): ClientRequest {
  const callable = original as unknown as (this: object, ...requestArgs: unknown[]) => ClientRequest;
  return callable.apply(target, [...args]);
}

function instrumentClientRequest(
  active: ActiveHttpContext,
  span: Span,
  details: NodeRequestDetails,
  request: ClientRequest
): ClientRequest {
  const requestBody = createBodyAccumulator();
  let finalized = false;

  const complete = (output: unknown, error: SpanError | null): void => {
    if (finalized) {
      return;
    }
    finalized = true;
    const input = {
      ...details,
      body: finalizeBodyAccumulator(requestBody)
    };
    active.session.addSpan(completeHttpSpan(active.context, span, input, output, error));
  };

  const mutableRequest = request as unknown as MutableClientRequestMethods;
  const originalWrite = request.write as (this: ClientRequest, ...args: unknown[]) => boolean;
  const originalEnd = request.end as (this: ClientRequest, ...args: unknown[]) => ClientRequest;

  mutableRequest.write = function ghosttraceRequestWrite(this: ClientRequest, ...writeArgs: unknown[]): boolean {
    captureNodeRequestChunk(requestBody, writeArgs);
    return originalWrite.call(this, ...writeArgs);
  };

  mutableRequest.end = function ghosttraceRequestEnd(this: ClientRequest, ...endArgs: unknown[]): ClientRequest {
    captureNodeRequestChunk(requestBody, endArgs);
    return originalEnd.call(this, ...endArgs);
  };

  request.once('response', (response) => {
    patchIncomingMessage(response, complete);
  });
  request.once('error', (error) => {
    complete(undefined, spanErrorFromUnknown(error));
  });
  request.once('timeout', () => {
    complete(undefined, timeoutSpanError('HTTP request timed out'));
  });
  request.once('abort', () => {
    complete(undefined, abortSpanError('HTTP request aborted'));
  });

  return request;
}

function createPatchedNodeRequest(
  protocol: RequestProtocol,
  target: object,
  getOriginal: () => NodeRequestFunction | undefined
): (...args: unknown[]) => ClientRequest {
  return function ghosttracePatchedNodeRequest(...args: unknown[]): ClientRequest {
    const original = getOriginal();
    if (original === undefined) {
      throw new TypeError(`${protocol === 'http:' ? 'http' : 'https'}.request is not available`);
    }

    const active = activeHttpContext();
    if (active === undefined) {
      return callNodeRequest(original, target, args);
    }

    const details = nodeRequestDetails(protocol, args);
    const span = pendingHttpSpan(active.context, `${protocol === 'http:' ? 'http' : 'https'}.request`, details);

    try {
      const request = runWithSpanContext(span, () => callNodeRequest(original, target, args));
      return instrumentClientRequest(active, span, details, request);
    } catch (error) {
      active.session.addSpan(completeHttpSpan(active.context, span, details, undefined, spanErrorFromUnknown(error)));
      throw error;
    }
  };
}

function installNodeRequestPatches(): void {
  if (originalHttpRequest === undefined && typeof nodeHttp.request === 'function') {
    originalHttpRequest = nodeHttp.request;
    patchedHttpRequest = createPatchedNodeRequest('http:', nodeHttp, () => originalHttpRequest) as HttpRequestFunction;
    nodeHttp.request = patchedHttpRequest;
  }

  if (originalHttpsRequest === undefined && typeof nodeHttps.request === 'function') {
    originalHttpsRequest = nodeHttps.request;
    patchedHttpsRequest = createPatchedNodeRequest('https:', nodeHttps, () => originalHttpsRequest) as HttpsRequestFunction;
    nodeHttps.request = patchedHttpsRequest;
  }

  syncBuiltinESMExports();
}

function restoreGlobalFetchPatchIfIdle(): void {
  if (activeHttpSessions.size > 0 || patchedFetch === undefined) {
    return;
  }

  if (globalThis.fetch === patchedFetch && originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
  }

  originalFetch = undefined;
  patchedFetch = undefined;
}

function restoreNodeRequestPatchesIfIdle(): void {
  if (activeHttpSessions.size > 0) {
    return;
  }

  if (patchedHttpRequest !== undefined && originalHttpRequest !== undefined && nodeHttp.request === patchedHttpRequest) {
    nodeHttp.request = originalHttpRequest;
  }
  if (patchedHttpsRequest !== undefined && originalHttpsRequest !== undefined && nodeHttps.request === patchedHttpsRequest) {
    nodeHttps.request = originalHttpsRequest;
  }

  originalHttpRequest = undefined;
  patchedHttpRequest = undefined;
  originalHttpsRequest = undefined;
  patchedHttpsRequest = undefined;
  syncBuiltinESMExports();
}

/** HTTP interceptor that records fetch and Node.js http/https calls during an active recording context. */
export const httpInterceptor: Interceptor = {
  name: 'http',
  install: (context: InterceptorContext): Teardown => {
    void markHttpInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return () => undefined;
    }

    activeHttpSessions.set(traceContext.traceId, {
      addSpan: context.addSpan
    });
    installGlobalFetchPatch();
    installNodeRequestPatches();

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }
      installed = false;
      activeHttpSessions.delete(traceContext.traceId);
      restoreGlobalFetchPatchIfIdle();
      restoreNodeRequestPatchesIfIdle();
    };
  },
  isAvailable: (): boolean => fetchAvailable() || typeof nodeHttp.request === 'function' || typeof nodeHttps.request === 'function'
};
