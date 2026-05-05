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
import { deserialize, serialize, stringifySerialized, writeSerializedJson } from './core/serializer.js';
import {
  TRACE_FORMAT_VERSION,
  SpanType,
  type CreateTraceOptions,
  type GhostTraceConfig,
  type RecordOptions,
  type ReplayOptions,
  type ReplayResult,
  type Span,
  type Trace,
  type TraceMetadata,
  type TraceableFunction,
  type Tracer
} from './core/types.js';
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
  type RecordOptions,
  type ReplayOptions,
  type ReplayResult,
  type Span,
  type SpanError,
  type SpanMetadata,
  type ReplaySpanMatch,
  type Trace,
  type TraceMetadata,
  type TraceableFunction,
  type Tracer
} from './core/types.js';
export type { Interceptor, InterceptorContext, Teardown } from './interceptors/index.js';
export { functionInterceptor, httpInterceptor, fsInterceptor } from './interceptors/index.js';

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

function notImplemented(featureName: string): GhostTraceError {
  return new GhostTraceError(`${featureName} is not implemented in the foundation package setup yet`, {
    code: 'GHOSTTRACE_NOT_IMPLEMENTED',
    context: { featureName }
  });
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

/** Records a named function execution in future recording-engine features. */
export async function record<TOutput>(
  name: string,
  fn: TraceableFunction<TOutput>,
  options: RecordOptions = {}
): Promise<Trace> {
  void name;
  void fn;
  void options;
  throw notImplemented('record');
}

/** Replays a function using a trace object or trace file path in future replay features. */
export async function replay<TOutput, TSpan extends Span = Span>(
  trace: Trace<TSpan> | string,
  fn: TraceableFunction<TOutput>,
  options: ReplayOptions = {}
): Promise<ReplayResult<Awaited<TOutput>, TSpan>> {
  void trace;
  void fn;
  void options;
  throw notImplemented('replay');
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

/** Foundation wrapper that preserves a function until recording is implemented. */
export function wrap<TFunction extends (...args: never[]) => unknown>(fn: TFunction): TFunction {
  return fn;
}

/** Foundation module wrapper that preserves module exports until recording is implemented. */
export function wrapModule<TModule extends object>(moduleExports: TModule): TModule {
  return moduleExports;
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
  record,
  replay,
  serialize,
  deserialize,
  stringifySerialized,
  writeSerializedJson,
  wrap,
  wrapModule,
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
