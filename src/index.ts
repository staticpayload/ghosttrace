import {
  AdapterError,
  ExportError,
  GhostTraceError,
  RecordingError,
  RedactionError,
  ReplayExhaustedError,
  ReplayMismatchError,
  SerializationError,
  TraceValidationError,
  TraceVersionError
} from './core/errors.js';
import { createTraceContext, getTraceContext, requireTraceContext, runWithSpanContext, runWithTraceContext } from './core/context.js';
import { createVirtualClock } from './core/clock.js';
import { createIdGenerator } from './core/id.js';
import { defaultTraceFileName, sanitizeTraceNameForFilename, saveTrace } from './core/persistence.js';
import { deserialize, serialize, stringifySerialized, writeSerializedJson } from './core/serializer.js';
import {
  TRACE_FORMAT_VERSION,
  SpanType,
  type CreateTraceOptions,
  type GhostTraceConfig,
  type ReplayOptions,
  type ReplayResult,
  type Span,
  type Trace,
  type TraceMetadata,
  type TraceableFunction,
  type Tracer
} from './core/types.js';
import { wrap, wrapModule } from './interceptors/function.js';
import { wrapDb } from './interceptors/db.js';
import { wrapQueue } from './interceptors/queue.js';
import { record, registerInterceptor } from './recorder/index.js';
import { replay as replayTrace } from './replay/index.js';
import { VERSION } from './version.js';

export { VERSION } from './version.js';
export {
  AdapterError,
  ExportError,
  GhostTraceError,
  RecordingError,
  RedactionError,
  ReplayExhaustedError,
  ReplayMismatchError,
  SerializationError,
  TraceValidationError,
  TraceVersionError
} from './core/errors.js';
export type { GhostTraceErrorOptions } from './core/errors.js';
export {
  createTraceContext,
  getTraceContext,
  requireTraceContext,
  runWithSpanContext,
  runWithTraceContext,
  type CreateTraceContextOptions,
  type TraceContext,
  type TraceContextMode
} from './core/context.js';
export { createVirtualClock, type VirtualClock, type VirtualClockOptions } from './core/clock.js';
export { createIdGenerator, type DeterministicIdGenerator, type IdGeneratorOptions } from './core/id.js';
export { defaultTraceFileName, sanitizeTraceNameForFilename, saveTrace } from './core/persistence.js';
export {
  deserialize,
  serialize,
  serializeToJsonChunks,
  stringifySerialized,
  writeSerializedJson,
  type SerializedJsonObject,
  type SerializedJsonPrimitive,
  type SerializedJsonValue,
  type SerializeOptions,
  type WriteSerializedJsonOptions
} from './core/serializer.js';
export {
  TRACE_FORMAT_VERSION,
  SpanType,
  type CreateTraceOptions,
  type GhostTraceConfig,
  type ReplayMatchStrategy,
  type ReplayMode,
  type RecordedTrace,
  type RecordOptions,
  type ReplayOptions,
  type ReplayResult,
  type Span,
  type SpanError,
  type SpanMetadata,
  type ReplaySpanMatch,
  type Trace,
  type TraceMetadata,
  type TraceSaveFunction,
  type TraceSaveOptions,
  type TraceSaveTarget,
  type TraceableFunction,
  type Tracer
} from './core/types.js';
export type {
  DbAdapter,
  DbOperationDescriptor,
  DbParamsExtractor,
  DbQueryExtractor,
  DbResultExtractor,
  DbRowCountExtractor,
  DbTransactionDescriptor,
  DbTransactionIdExtractor,
  Interceptor,
  InterceptorContext,
  QueueAdapter,
  QueueMessageIdExtractor,
  QueueNameExtractor,
  QueueOperationDescriptor,
  QueuePayloadExtractor,
  Teardown
} from './interceptors/index.js';
export {
  dbInterceptor,
  envInterceptor,
  fsInterceptor,
  functionInterceptor,
  httpInterceptor,
  performanceInterceptor,
  queueInterceptor,
  randomInterceptor,
  timerInterceptor,
  wrap,
  wrapDb,
  wrapModule,
  wrapQueue
} from './interceptors/index.js';
export { record, registerInterceptor } from './recorder/index.js';

function cloneMetadata(metadata: TraceMetadata | undefined): TraceMetadata {
  return metadata === undefined ? {} : { ...metadata };
}

function normalizeConfig(config: GhostTraceConfig): GhostTraceConfig {
  const normalized: {
    traceDir?: string;
    interceptors?: readonly string[];
    metadata?: TraceMetadata;
  } = {};

  if (config.traceDir !== undefined) {
    normalized.traceDir = config.traceDir;
  }
  if (config.interceptors !== undefined) {
    normalized.interceptors = [...config.interceptors];
  }
  if (config.metadata !== undefined) {
    normalized.metadata = cloneMetadata(config.metadata);
  }

  return normalized;
}

/** Creates a Trace object with deterministic foundation defaults. */
export function createTrace<TTraceSpan extends Trace['spans'][number]>(
  options: CreateTraceOptions<TTraceSpan>
): Trace<TTraceSpan> {
  const startTime = options.startTime ?? 0;
  const endTime = options.endTime ?? startTime;

  return {
    id: options.id,
    name: options.name,
    version: options.version ?? TRACE_FORMAT_VERSION,
    startTime,
    endTime,
    duration: endTime - startTime,
    spans: options.spans ?? [],
    metadata: cloneMetadata(options.metadata)
  };
}

/** Validates and returns GhostTrace configuration for typed config files. */
export function defineConfig(config: GhostTraceConfig = {}): GhostTraceConfig {
  return normalizeConfig(config);
}

/** Replays a function using a trace object or trace file path in future replay features. */
export async function replay<TOutput, TSpan extends Span = Span>(
  trace: Trace<TSpan> | string,
  fn: TraceableFunction<TOutput>,
  options: ReplayOptions = {}
): Promise<ReplayResult<Awaited<TOutput>, TSpan>> {
  return replayTrace(trace, fn, options);
}

/** Returns an isolated GhostTrace API instance with captured configuration. */
export function createTracer(config: GhostTraceConfig = {}): Tracer {
  const normalizedConfig = defineConfig(config);

  return {
    config: normalizedConfig,
    record,
    replay,
    defineConfig
  };
}

/** Public namespace mirroring the named GhostTrace exports. */
export const ghost = {
  VERSION,
  SpanType,
  createTrace,
  defineConfig,
  createTracer,
  createTraceContext,
  getTraceContext,
  requireTraceContext,
  runWithSpanContext,
  runWithTraceContext,
  createVirtualClock,
  createIdGenerator,
  defaultTraceFileName,
  sanitizeTraceNameForFilename,
  saveTrace,
  record,
  replay,
  serialize,
  deserialize,
  stringifySerialized,
  writeSerializedJson,
  registerInterceptor,
  wrap,
  wrapDb,
  wrapModule,
  wrapQueue,
  GhostTraceError,
  RecordingError,
  ReplayMismatchError,
  ReplayExhaustedError,
  TraceValidationError,
  TraceVersionError,
  RedactionError,
  AdapterError,
  SerializationError,
  ExportError
} as const;
