import { createTraceContext, runWithSpanContext, runWithTraceContext, type TraceContext } from '../core/context.js';
import { RecordingError } from '../core/errors.js';
import { attachTraceSave } from '../core/persistence.js';
import { serialize } from '../core/serializer.js';
import {
  SpanType,
  TRACE_FORMAT_VERSION,
  type RecordedTrace,
  type RecordOptions,
  type Span,
  type SpanError,
  type Trace,
  type TraceMetadata,
  type TraceableFunction
} from '../core/types.js';
import {
  dbInterceptor,
  envInterceptor,
  fsInterceptor,
  functionInterceptor,
  httpInterceptor,
  performanceInterceptor,
  queueInterceptor,
  randomInterceptor,
  timerInterceptor,
  type Interceptor,
  type InterceptorContext,
  type Teardown
} from '../interceptors/index.js';
import { normalizeRedactionOptions, redactTrace, redactValue } from '../redaction/index.js';

interface RecordedSpan {
  readonly span: Span;
  readonly order: number;
}

interface InstalledInterceptor {
  readonly name: string;
  readonly teardown: Teardown;
}

interface MutableSpanError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SpanError;
}

const defaultInterceptors = [
  functionInterceptor,
  httpInterceptor,
  fsInterceptor,
  timerInterceptor,
  randomInterceptor,
  envInterceptor,
  dbInterceptor,
  queueInterceptor,
  performanceInterceptor
] as const;
const interceptorRegistry = new Map<string, Interceptor>(
  defaultInterceptors.map((interceptor) => [interceptor.name, interceptor])
);

let nextTraceSequence = 1;
let lastRecordingTimestampMs = 0;

function nextTraceId(): string {
  const traceId = `trace_${String(nextTraceSequence).padStart(4, '0')}`;
  nextTraceSequence += 1;
  return traceId;
}

function cloneMetadata(metadata: TraceMetadata | undefined): TraceMetadata {
  return metadata === undefined ? {} : { ...metadata };
}

function nextRecordedAt(): string {
  const now = Date.now();
  const timestampMs = now <= lastRecordingTimestampMs ? lastRecordingTimestampMs + 1 : now;
  lastRecordingTimestampMs = timestampMs;

  return new Date(timestampMs).toISOString();
}

function createRecordingMetadata(name: string, metadata: TraceMetadata | undefined): TraceMetadata {
  return {
    ...cloneMetadata(metadata),
    name,
    recordedAt: nextRecordedAt()
  };
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

function createPendingRootSpan(context: TraceContext, name: string, fn: TraceableFunction<unknown>): Span {
  const startTime = context.clock.now();
  const functionName = fn.name === '' ? name : fn.name;

  return {
    id: context.idGenerator.next(),
    parentId: null,
    type: SpanType.Function,
    name: functionName,
    startTime,
    endTime: startTime,
    duration: 0,
    input: [],
    output: serialize(undefined),
    children: [],
    error: null,
    metadata: {
      traceName: name
    }
  };
}

function completeRootSpan(rootSpan: Span, endTime: number, output: unknown, error: SpanError | null): Span {
  return {
    ...rootSpan,
    endTime,
    duration: endTime - rootSpan.startTime,
    output,
    error,
    children: []
  };
}

function createErrorSpan(context: TraceContext, name: string, error: unknown, metadata: TraceMetadata): Span {
  const startTime = context.clock.now();
  const endTime = context.clock.now();

  return {
    id: context.idGenerator.next(),
    parentId: context.currentSpan?.id ?? null,
    type: SpanType.Error,
    name,
    startTime,
    endTime,
    duration: endTime - startTime,
    input: serialize(metadata),
    output: serialize(undefined),
    children: [],
    error: spanErrorFromUnknown(error),
    metadata
  };
}

function clampTimestamp(timestamp: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(timestamp)) {
    return minimum;
  }

  return Math.min(Math.max(timestamp, minimum), maximum);
}

function normalizeSpan(span: Span, traceStartTime: number, traceEndTime: number): Span {
  const boundedTraceEndTime = Math.max(traceStartTime, traceEndTime);
  const startTime = clampTimestamp(span.startTime, traceStartTime, boundedTraceEndTime);
  const endTime = clampTimestamp(span.endTime, startTime, boundedTraceEndTime);

  return {
    ...span,
    startTime,
    endTime,
    duration: endTime - startTime,
    children: []
  };
}

function buildChildren(
  span: Span,
  childrenByParentId: ReadonlyMap<string, readonly Span[]>,
  ancestry: ReadonlySet<string>
): Span {
  if (ancestry.has(span.id)) {
    return {
      ...span,
      children: []
    };
  }

  const nextAncestry = new Set(ancestry);
  nextAncestry.add(span.id);
  const children = childrenByParentId.get(span.id) ?? [];

  return {
    ...span,
    children: children.map((child) => buildChildren(child, childrenByParentId, nextAncestry))
  };
}

function buildChronologicalSpanTree(
  recordedSpans: readonly RecordedSpan[],
  traceStartTime: number,
  traceEndTime: number
): readonly Span[] {
  const sortedSpans = recordedSpans
    .map(({ span, order }) => ({ span: normalizeSpan(span, traceStartTime, traceEndTime), order }))
    .sort((left, right) => left.span.startTime - right.span.startTime || left.order - right.order);
  const spanIds = new Set(sortedSpans.map(({ span }) => span.id));
  const childrenByParentId = new Map<string, Span[]>();

  for (const { span } of sortedSpans) {
    if (span.parentId !== null && spanIds.has(span.parentId)) {
      const children = childrenByParentId.get(span.parentId) ?? [];
      children.push(span);
      childrenByParentId.set(span.parentId, children);
    }
  }

  return sortedSpans.map(({ span }) => buildChildren(span, childrenByParentId, new Set()));
}

function selectedInterceptorNames(options: RecordOptions): readonly string[] {
  const names = options.interceptors ?? [...interceptorRegistry.keys()];
  return [...new Set(names)];
}

function isExplicitlySelected(options: RecordOptions, interceptorName: string): boolean {
  return options.interceptors?.includes(interceptorName) ?? false;
}

function warnUnavailableInterceptor(interceptorName: string): void {
  console.warn(`GhostTrace interceptor "${interceptorName}" is unavailable and was skipped`);
}

function createInterceptorContext(addSpan: (span: Span) => void): InterceptorContext {
  return {
    addSpan
  };
}

function addInterceptorErrorSpan(
  context: TraceContext,
  addSpan: (span: Span) => void,
  interceptorName: string,
  phase: string,
  error: unknown
): void {
  addSpan(
    createErrorSpan(context, `interceptor:${interceptorName}:${phase}`, error, {
      interceptor: interceptorName,
      phase
    })
  );
}

function installSelectedInterceptors(
  context: TraceContext,
  addSpan: (span: Span) => void,
  options: RecordOptions
): readonly InstalledInterceptor[] {
  const installed: InstalledInterceptor[] = [];
  const interceptorContext = createInterceptorContext(addSpan);

  for (const name of selectedInterceptorNames(options)) {
    const interceptor = interceptorRegistry.get(name);

    if (interceptor === undefined) {
      addInterceptorErrorSpan(context, addSpan, name, 'missing', new RecordingError(`Interceptor "${name}" is not registered`, {
        traceId: context.traceId,
        context: { interceptor: name }
      }));
      continue;
    }

    let available = false;
    try {
      available = interceptor.isAvailable();
    } catch (error) {
      addInterceptorErrorSpan(context, addSpan, name, 'availability', error);
      continue;
    }

    if (!available) {
      if (isExplicitlySelected(options, name)) {
        warnUnavailableInterceptor(name);
      }
      continue;
    }

    try {
      installed.push({
        name,
        teardown: interceptor.install(interceptorContext)
      });
    } catch (error) {
      addInterceptorErrorSpan(context, addSpan, name, 'install', error);
    }
  }

  return installed;
}

function teardownInstalledInterceptors(
  context: TraceContext,
  addSpan: (span: Span) => void,
  installedInterceptors: readonly InstalledInterceptor[]
): void {
  for (const installed of [...installedInterceptors].reverse()) {
    try {
      installed.teardown();
    } catch (error) {
      addInterceptorErrorSpan(context, addSpan, installed.name, 'teardown', error);
    }
  }
}

function traceEndTime(spans: readonly Span[], fallbackEndTime: number): number {
  return spans.reduce(
    (endTime, span) => Math.max(endTime, span.endTime, traceEndTime(span.children, endTime)),
    fallbackEndTime
  );
}

/** Registers an interceptor for future recording sessions and returns an unregister teardown. */
export function registerInterceptor(interceptor: Interceptor): Teardown {
  if (interceptor.name.length === 0) {
    throw new RecordingError('Interceptor name must not be empty', {
      code: 'GHOSTTRACE_INTERCEPTOR_INVALID'
    });
  }

  const previousInterceptor = interceptorRegistry.get(interceptor.name);
  let registered = true;
  interceptorRegistry.set(interceptor.name, interceptor);

  return () => {
    if (!registered) {
      return;
    }
    registered = false;

    if (previousInterceptor === undefined) {
      interceptorRegistry.delete(interceptor.name);
    } else {
      interceptorRegistry.set(interceptor.name, previousInterceptor);
    }
  };
}

/** Records a named function execution into a complete GhostTrace trace. */
export async function record<TOutput>(
  name: string,
  fn: TraceableFunction<TOutput>,
  options: RecordOptions = {}
): Promise<RecordedTrace> {
  const redactionOptions = normalizeRedactionOptions(options.redaction);
  const traceId = nextTraceId();
  const metadata = createRecordingMetadata(name, options.metadata);
  const baseContext = createTraceContext({ traceId, metadata });
  const rootPendingSpan = createPendingRootSpan(baseContext, name, fn);
  const context: TraceContext = {
    ...baseContext,
    currentSpan: rootPendingSpan
  };
  const recordedSpans: RecordedSpan[] = [];
  let nextSpanOrder = 1;
  let rootOutput: unknown = serialize(undefined);
  let rootError: SpanError | null = null;
  let rootEndTime = rootPendingSpan.startTime;

  const addSpan = (span: Span): void => {
    recordedSpans.push({
      span,
      order: nextSpanOrder
    });
    nextSpanOrder += 1;
  };

  await runWithTraceContext(context, async () => {
    const installedInterceptors = installSelectedInterceptors(context, addSpan, options);

    try {
      const output = await runWithSpanContext(rootPendingSpan, fn);
      rootOutput = serialize(redactValue(output, redactionOptions));
    } catch (error) {
      rootError = spanErrorFromUnknown(error);
      rootOutput = serialize(undefined);
    } finally {
      rootEndTime = context.clock.now();
      teardownInstalledInterceptors(context, addSpan, installedInterceptors);
    }
  });

  const rootSpan = completeRootSpan(rootPendingSpan, rootEndTime, rootOutput, rootError);
  const spans = buildChronologicalSpanTree(
    [
      {
        span: rootSpan,
        order: 0
      },
      ...recordedSpans
    ],
    rootSpan.startTime,
    rootSpan.endTime
  );
  const endTime = traceEndTime(spans, rootSpan.endTime);

  const trace: Trace = {
    id: traceId,
    name,
    version: TRACE_FORMAT_VERSION,
    startTime: rootSpan.startTime,
    endTime,
    duration: endTime - rootSpan.startTime,
    spans,
    metadata
  };

  return attachTraceSave(redactTrace(trace, redactionOptions));
}
