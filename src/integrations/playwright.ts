import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { ReplayMismatchError } from '../core/errors.js';
import { saveTrace } from '../core/persistence.js';
import { deserialize, serialize, type SerializedJsonValue } from '../core/serializer.js';
import { SpanType, TRACE_FORMAT_VERSION, type RecordOptions, type Span, type SpanError, type Trace } from '../core/types.js';
import {
  normalizeTraceDirectory,
  resolveTraceName,
  traceFileForName,
  warnFrameworkTraceReRecord
} from './shared.js';
import { validateTrace, type TraceValidationResult } from '../validation/index.js';

/** Options accepted by the Playwright integration entry point. */
export interface GhostPlaywrightOptions {
  /** Directory containing trace baselines. */
  readonly traceDir?: string;
  /** Interceptors to enable while recording. */
  readonly interceptors?: RecordOptions['interceptors'];
  /** Stable trace name used to derive the network baseline file. */
  readonly traceName?: string;
}

/** Minimal Playwright request surface consumed by GhostTrace network interception. */
export interface GhostPlaywrightRequest {
  /** Returns the request URL. */
  readonly url: () => string;
  /** Returns the request method. */
  readonly method: () => string;
  /** Returns request headers as a plain object. */
  readonly headers: () => Record<string, string>;
  /** Returns the request body as text when available. */
  readonly postData?: () => string | null;
}

/** Minimal Playwright response surface consumed by GhostTrace network interception. */
export interface GhostPlaywrightResponse {
  /** Returns the response status code. */
  readonly status: () => number;
  /** Returns the response status text. */
  readonly statusText?: () => string;
  /** Returns response headers as a plain object. */
  readonly headers: () => Record<string, string>;
  /** Returns the response body bytes. */
  readonly body: () => Promise<Buffer>;
}

/** Minimal Playwright route surface consumed by GhostTrace network interception. */
export interface GhostPlaywrightRoute {
  /** Returns the intercepted request. */
  readonly request: () => GhostPlaywrightRequest;
  /** Fetches the real network response during recording. */
  readonly fetch: () => Promise<GhostPlaywrightResponse>;
  /** Fulfills the intercepted request with recorded or live response data. */
  readonly fulfill: (options: GhostPlaywrightFulfillOptions) => Promise<void>;
}

/** Minimal Playwright page surface consumed by GhostTrace network interception. */
export interface GhostPlaywrightPage {
  /** Routes matching network requests to a handler. */
  readonly route: (url: string, handler: (route: GhostPlaywrightRoute) => void | Promise<void>) => Promise<void>;
}

/** Response options passed to Playwright route.fulfill(). */
export interface GhostPlaywrightFulfillOptions {
  /** Response status code. */
  readonly status?: number;
  /** Response headers. */
  readonly headers?: Record<string, string>;
  /** Response body. */
  readonly body?: string | Buffer;
}

/** Playwright integration surface exported for page-level network interception. */
export interface GhostPlaywrightController {
  /** Captured integration options. */
  readonly options: GhostPlaywrightOptions;
  /** Trace file path associated with this controller. */
  readonly traceFile: string;
  /** Spans recorded or replayed by the most recent page interception. */
  readonly spans: readonly Span[];
  /** Forces the next interceptPage() call to record a fresh baseline. */
  readonly update: () => Promise<void>;
  /** Attaches GhostTrace network interception to a Playwright page. */
  readonly interceptPage: (page: GhostPlaywrightPage) => Promise<void>;
}

interface PlaywrightRequestDetails {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

interface PlaywrightResponseDetails {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer;
}

interface PlaywrightControllerState {
  spans: readonly Span[];
  hasBaseline: boolean;
  updateNext: boolean;
  nextSpanSequence: number;
  nextTimestamp: number;
  traceId: string;
  recordedAt: string;
}

let nextPlaywrightTraceSequence = 1;

function nextTraceId(): string {
  const sequence = nextPlaywrightTraceSequence;
  nextPlaywrightTraceSequence += 1;
  return `trace_playwright_${String(sequence).padStart(4, '0')}`;
}

function resetRecordingState(state: PlaywrightControllerState): void {
  state.spans = [];
  state.nextSpanSequence = 1;
  state.nextTimestamp = 0;
  state.traceId = nextTraceId();
  state.recordedAt = new Date().toISOString();
}

function nextSpanId(state: PlaywrightControllerState): string {
  const spanId = `span_${String(state.nextSpanSequence).padStart(4, '0')}`;
  state.nextSpanSequence += 1;
  return spanId;
}

function nextTimestamp(state: PlaywrightControllerState): number {
  const timestamp = state.nextTimestamp;
  state.nextTimestamp += 1;
  return timestamp;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function spanErrorFromUnknown(error: unknown): SpanError {
  if (error instanceof Error) {
    const spanError: {
      name: string;
      message: string;
      stack?: string;
      code?: string;
    } = {
      name: error.name,
      message: error.message
    };
    const maybeCode = (error as Error & { readonly code?: unknown }).code;

    if (error.stack !== undefined) {
      spanError.stack = error.stack;
    }
    if (typeof maybeCode === 'string') {
      spanError.code = maybeCode;
    }

    return spanError;
  }

  return {
    name: error === null ? 'null' : typeof error,
    message: String(error)
  };
}

function requestPostData(request: GhostPlaywrightRequest): string | undefined {
  if (request.postData === undefined) {
    return undefined;
  }

  const body = request.postData();
  return body === null ? undefined : body;
}

function requestDetails(request: GhostPlaywrightRequest): PlaywrightRequestDetails {
  const body = requestPostData(request);
  const details: {
    method: string;
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
  } = {
    method: request.method().toUpperCase(),
    url: request.url(),
    headers: request.headers()
  };

  if (body !== undefined) {
    details.body = body;
  }

  return details;
}

async function responseDetails(response: GhostPlaywrightResponse): Promise<PlaywrightResponseDetails> {
  return {
    status: response.status(),
    statusText: response.statusText?.() ?? '',
    headers: response.headers(),
    body: await response.body()
  };
}

function pendingSpan(state: PlaywrightControllerState, input: PlaywrightRequestDetails): Span {
  const startTime = nextTimestamp(state);

  return {
    id: nextSpanId(state),
    parentId: null,
    type: SpanType.Http,
    name: 'page.request',
    startTime,
    endTime: startTime,
    duration: 0,
    input: serialize(input),
    output: serialize(undefined),
    children: [],
    error: null,
    metadata: {
      source: 'playwright'
    }
  };
}

function completeSpan(
  state: PlaywrightControllerState,
  span: Span,
  output: PlaywrightResponseDetails | undefined,
  error: SpanError | null
): Span {
  const endTime = nextTimestamp(state);

  return {
    ...span,
    endTime,
    duration: endTime - span.startTime,
    output: serialize(output),
    error,
    children: []
  };
}

function traceEndTime(spans: readonly Span[]): number {
  return spans.reduce((endTime, span) => Math.max(endTime, span.endTime), 0);
}

function createTrace(traceName: string, traceFile: string, state: PlaywrightControllerState): Trace {
  const endTime = traceEndTime(state.spans);

  return {
    id: state.traceId,
    name: traceName,
    version: TRACE_FORMAT_VERSION,
    startTime: 0,
    endTime,
    duration: endTime,
    spans: state.spans,
    metadata: {
      framework: 'playwright',
      name: traceName,
      traceFile,
      recordedAt: state.recordedAt
    }
  };
}

async function savePlaywrightTrace(
  traceName: string,
  traceFile: string,
  state: PlaywrightControllerState
): Promise<void> {
  await saveTrace(createTrace(traceName, traceFile, state), { filePath: traceFile });
  state.hasBaseline = true;
}

function validationFailureReason(validation: TraceValidationResult): string {
  if (validation.errors.length === 0) {
    return 'unavailable';
  }

  return validation.errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ');
}

async function loadReplayTraceOrRecord(
  traceFile: string,
  state: PlaywrightControllerState
): Promise<Trace | undefined> {
  if (state.updateNext) {
    state.updateNext = false;
    return undefined;
  }

  if (!existsSync(traceFile)) {
    if (state.hasBaseline) {
      warnFrameworkTraceReRecord('playwright', traceFile, 'missing');
    }
    return undefined;
  }

  const validation = await validateTrace(traceFile);
  if (validation.valid && validation.trace !== undefined) {
    state.hasBaseline = true;
    state.spans = validation.trace.spans;
    return validation.trace;
  }

  warnFrameworkTraceReRecord('playwright', traceFile, validationFailureReason(validation));
  return undefined;
}

function appendSpan(state: PlaywrightControllerState, span: Span): void {
  state.spans = [...state.spans, span];
}

function fulfillOptions(output: PlaywrightResponseDetails): GhostPlaywrightFulfillOptions {
  const options: {
    status: number;
    headers: Record<string, string>;
    body?: string | Buffer;
  } = {
    status: output.status,
    headers: { ...output.headers }
  };

  if (output.body !== undefined) {
    options.body = output.body;
  }

  return options;
}

async function recordRoute(
  route: GhostPlaywrightRoute,
  traceName: string,
  traceFile: string,
  state: PlaywrightControllerState
): Promise<void> {
  const input = requestDetails(route.request());
  const span = pendingSpan(state, input);

  try {
    const response = await route.fetch();
    const output = await responseDetails(response);
    appendSpan(state, completeSpan(state, span, output, null));
    await savePlaywrightTrace(traceName, traceFile, state);
    await route.fulfill(fulfillOptions(output));
  } catch (error) {
    appendSpan(state, completeSpan(state, span, undefined, spanErrorFromUnknown(error)));
    await savePlaywrightTrace(traceName, traceFile, state);
    throw error;
  }
}

function deserializeSpanValue(value: unknown): unknown {
  return deserialize(value as SerializedJsonValue);
}

function spanInput(span: Span): PlaywrightRequestDetails | undefined {
  const input = deserializeSpanValue(span.input);
  if (!isRecord(input) || typeof input.method !== 'string' || typeof input.url !== 'string') {
    return undefined;
  }

  const details: {
    method: string;
    url: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
  } = {
    method: input.method,
    url: input.url,
    headers: isRecord(input.headers)
      ? Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key, String(value)]))
      : {}
  };

  if (typeof input.body === 'string') {
    details.body = input.body;
  }

  return details;
}

function spanOutput(span: Span): PlaywrightResponseDetails {
  const output = deserializeSpanValue(span.output);
  if (!isRecord(output) || typeof output.status !== 'number') {
    throw new ReplayMismatchError(`Recorded Playwright span ${span.id} is missing response output`, {
      spanId: span.id,
      context: { output: span.output }
    });
  }

  return {
    status: output.status,
    statusText: typeof output.statusText === 'string' ? output.statusText : '',
    headers: isRecord(output.headers)
      ? Object.fromEntries(Object.entries(output.headers).map(([key, value]) => [key, String(value)]))
      : {},
    body: Buffer.isBuffer(output.body) ? output.body : Buffer.from(String(output.body ?? ''), 'utf8')
  };
}

function requestMatches(recorded: PlaywrightRequestDetails | undefined, actual: PlaywrightRequestDetails): boolean {
  return recorded?.method === actual.method && recorded.url === actual.url;
}

function errorFromSpan(span: Span): Error | undefined {
  if (span.error === null) {
    return undefined;
  }

  const error = new Error(span.error.message);
  error.name = span.error.name;
  return error;
}

function consumeReplaySpan(
  trace: Trace,
  consumedSpanIds: Set<string>,
  input: PlaywrightRequestDetails
): Span {
  const httpSpans = trace.spans.filter((span) => span.type === SpanType.Http);
  const matchedSpan = httpSpans.find((span) => !consumedSpanIds.has(span.id) && requestMatches(spanInput(span), input));

  if (matchedSpan === undefined) {
    throw new ReplayMismatchError('No recorded Playwright network response matched the intercepted request', {
      traceId: trace.id,
      context: {
        input,
        availableRequests: httpSpans
          .filter((span) => !consumedSpanIds.has(span.id))
          .map((span) => ({
            id: span.id,
            input: spanInput(span)
          }))
      }
    });
  }

  consumedSpanIds.add(matchedSpan.id);
  return matchedSpan;
}

async function replayRoute(
  route: GhostPlaywrightRoute,
  trace: Trace,
  consumedSpanIds: Set<string>,
  state: PlaywrightControllerState
): Promise<void> {
  const input = requestDetails(route.request());
  const span = consumeReplaySpan(trace, consumedSpanIds, input);
  const error = errorFromSpan(span);

  appendSpan(state, span);
  if (error !== undefined) {
    throw error;
  }

  await route.fulfill(fulfillOptions(spanOutput(span)));
}

/** Creates a Playwright controller that records and replays page network traffic. */
export function createGhostPlaywright(options: GhostPlaywrightOptions = {}): GhostPlaywrightController {
  const traceName = resolveTraceName(options.traceName ?? '', 'ghosttrace-playwright-test');
  const traceDir = normalizeTraceDirectory(options.traceDir);
  const traceFile = traceFileForName(traceDir, traceName);
  const state: PlaywrightControllerState = {
    spans: [],
    hasBaseline: existsSync(traceFile),
    updateNext: false,
    nextSpanSequence: 1,
    nextTimestamp: 0,
    traceId: nextTraceId(),
    recordedAt: new Date().toISOString()
  };

  return {
    options: { ...options },
    traceFile,
    get spans(): readonly Span[] {
      return state.spans;
    },
    update: async (): Promise<void> => {
      state.updateNext = true;
    },
    interceptPage: async (page: GhostPlaywrightPage): Promise<void> => {
      const replayTrace = await loadReplayTraceOrRecord(traceFile, state);
      if (replayTrace === undefined) {
        resetRecordingState(state);
        await page.route('**/*', (route) => recordRoute(route, traceName, traceFile, state));
        return;
      }

      state.spans = [];
      const consumedSpanIds = new Set<string>();
      await page.route('**/*', (route) => replayRoute(route, replayTrace, consumedSpanIds, state));
    }
  };
}
