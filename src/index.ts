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
  type RecordOptions,
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
import {
  normalizeRedactionOptions,
  redactTrace,
  redactValue,
  redactionPlaceholder,
  type RedactionOptions
} from './redaction/index.js';
import { record, registerInterceptor } from './recorder/index.js';
import { replay as replayTrace } from './replay/index.js';
import { generateMocks } from './mock/index.js';
import { generateFixtures } from './fixture/index.js';
import { generateTests } from './regression/index.js';
import { diff as diffTraces, type DiffOptions, type DiffResult } from './contract/diff.js';
import {
  computeTraceChecksum,
  loadValidatedTrace,
  migrateTraceVersion,
  validateTrace as validateTraceInput,
  validateTraceForUse,
  verifyTraceChecksum,
  withTraceChecksum,
  type TraceValidationResult
} from './validation/index.js';
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
  type RecordOptions,
  type ReplayMatchStrategy,
  type ReplayMode,
  type RecordedTrace,
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
export {
  normalizeRedactionOptions,
  redactTrace,
  redactValue,
  redactionPlaceholder
} from './redaction/index.js';
export type {
  BuiltinRedactionPatternConfig,
  BuiltinRedactionPatternName,
  RedactionOptions,
  RedactionPathRule,
  RedactionRegexRule
} from './redaction/index.js';
export { record, registerInterceptor } from './recorder/index.js';
export { generateMocks } from './mock/index.js';
export { generateFixtures } from './fixture/index.js';
export { generateTests } from './regression/index.js';
export type {
  GenerateMocksOptions,
  MockExhaustionBehavior,
  MockGenerationFilter,
  MockGenerationFormat
} from './mock/index.js';
export type {
  FixtureGenerationFilter,
  FixtureGenerationFormat,
  GenerateFixturesOptions
} from './fixture/index.js';
export type {
  GenerateTestsOptions,
  TestAssertionStyle,
  TestGenerationFramework
} from './regression/index.js';
export type {
  AddedSpanChange,
  ChangedFieldChange,
  DiffChange,
  DiffChangeSeverity,
  DiffChangeType,
  DiffComparator,
  DiffComparatorContext,
  DiffOptions,
  DiffResult,
  DiffStats,
  DiffStatus,
  DiffWarning,
  RemovedSpanChange
} from './contract/diff.js';
export {
  computeTraceChecksum,
  migrateTraceVersion,
  verifyTraceChecksum,
  withTraceChecksum
} from './validation/index.js';
export type {
  ChecksummedTrace,
  TraceValidationIssue,
  TraceValidationIssueSeverity,
  TraceValidationResult
} from './validation/index.js';

function cloneMetadata(metadata: TraceMetadata | undefined): TraceMetadata {
  return metadata === undefined ? {} : { ...metadata };
}

function normalizeConfig(config: GhostTraceConfig): GhostTraceConfig {
  const normalized: {
    traceDir?: string;
    interceptors?: readonly string[];
    redaction?: RedactionOptions;
    metadata?: TraceMetadata;
  } = {};

  if (config.traceDir !== undefined) {
    normalized.traceDir = config.traceDir;
  }
  if (config.interceptors !== undefined) {
    normalized.interceptors = [...config.interceptors];
  }
  if (config.redaction !== undefined) {
    normalized.redaction = normalizeRedactionOptions(config.redaction);
  }
  if (config.metadata !== undefined) {
    normalized.metadata = cloneMetadata(config.metadata);
  }

  return normalized;
}

function mergeRecordOptions(config: GhostTraceConfig, options: RecordOptions | undefined): RecordOptions {
  const merged: {
    metadata?: TraceMetadata;
    interceptors?: readonly string[];
    redaction?: RedactionOptions;
  } = {};
  const configMetadata = config.metadata ?? {};
  const optionMetadata = options?.metadata ?? {};
  const metadata = {
    ...configMetadata,
    ...optionMetadata
  };

  if (Object.keys(metadata).length > 0) {
    merged.metadata = metadata;
  }
  if (options?.interceptors !== undefined) {
    merged.interceptors = options.interceptors;
  } else if (config.interceptors !== undefined) {
    merged.interceptors = config.interceptors;
  }
  if (options?.redaction !== undefined) {
    merged.redaction = options.redaction;
  } else if (config.redaction !== undefined) {
    merged.redaction = config.redaction;
  }

  return merged;
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

/** Validates a trace file path and returns machine-readable issues. */
export function validateTrace(path: string): Promise<TraceValidationResult>;
/** Validates an in-memory trace-like object and returns machine-readable issues. */
export function validateTrace<TSpan extends Span>(trace: Trace<TSpan> | unknown): TraceValidationResult<TSpan>;
export function validateTrace<TSpan extends Span>(
  input: Trace<TSpan> | string | unknown
): TraceValidationResult<TSpan> | Promise<TraceValidationResult> {
  return validateTraceInput(input);
}

/** Compares two validated traces using the contract diff engine. */
export function diff(baseline: Trace, current: Trace, options?: DiffOptions): DiffResult;
/** Compares trace file paths or mixed path/object inputs using the contract diff engine. */
export function diff(baseline: string, current: Trace | string, options?: DiffOptions): Promise<DiffResult>;
/** Compares trace file paths or mixed path/object inputs using the contract diff engine. */
export function diff(baseline: Trace, current: string, options?: DiffOptions): Promise<DiffResult>;
export function diff(
  baseline: Trace | string,
  current: Trace | string,
  options: DiffOptions = {}
): DiffResult | Promise<DiffResult> {
  if (typeof baseline === 'string' || typeof current === 'string') {
    return Promise.all([
      loadValidatedTrace(baseline, 'baseline'),
      loadValidatedTrace(current, 'current')
    ]).then(([baselineTrace, currentTrace]) => diffTraces(baselineTrace, currentTrace, options));
  }

  return diffTraces(
    validateTraceForUse(baseline, 'baseline'),
    validateTraceForUse(current, 'current'),
    options
  );
}

/** Returns an isolated GhostTrace API instance with captured configuration. */
export function createTracer(config: GhostTraceConfig = {}): Tracer {
  const normalizedConfig = defineConfig(config);

  return {
    config: normalizedConfig,
    record: (name, fn, options) => record(name, fn, mergeRecordOptions(normalizedConfig, options)),
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
  redactTrace,
  redactValue,
  redactionPlaceholder,
  normalizeRedactionOptions,
  record,
  replay,
  generateMocks,
  generateFixtures,
  generateTests,
  diff,
  validateTrace,
  computeTraceChecksum,
  withTraceChecksum,
  verifyTraceChecksum,
  migrateTraceVersion,
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
