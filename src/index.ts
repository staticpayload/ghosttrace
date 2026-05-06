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
  type GhostTracePlugin,
  type PluginRuntimeContext,
  type RecordOptions,
  type ReplayOptions,
  type ReplayResult,
  type Span,
  type TracerExportOptions,
  type Trace,
  type TraceMetadata,
  type TraceableFunction,
  type Tracer
} from './core/types.js';
import { wrap, wrapModule } from './interceptors/function.js';
import { wrapDb } from './interceptors/db.js';
import { wrapQueue } from './interceptors/queue.js';
import type { Interceptor } from './interceptors/types.js';
import {
  normalizeRedactionOptions,
  redactTrace,
  redactValue,
  redactionPlaceholder,
  type RedactionOptions
} from './redaction/index.js';
import { record, registeredInterceptorNames, registerInterceptor } from './recorder/index.js';
import { normalizePlugins, registerPlugin } from './plugins/index.js';
import { replay as replayTrace } from './replay/index.js';
import { generateMocks } from './mock/index.js';
import { generateFixtures } from './fixture/index.js';
import { generateTests } from './regression/index.js';
import { exportHtml, exportJson, exportMarkdown, exportMermaid, exportTrace, type ExportTraceOptions } from './export/index.js';
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

const GHOSTTRACE_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'traceDir',
  'interceptors',
  'redaction',
  'plugins',
  'metadata'
]);

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
  type GhostTracePlugin,
  type PluginHookContext,
  type PluginHooks,
  type PluginRuntimeContext,
  type PluginState,
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
  type TracerExportOptions,
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
export { registerPlugin } from './plugins/index.js';
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
export {
  applyExportPipeline,
  exportHtml,
  exportJson,
  exportMarkdown,
  exportMermaid,
  exportTrace,
  filterTraceForExport
} from './export/index.js';
export type {
  ExportHtmlOptions,
  ExportJsonOptions,
  ExportMermaidOptions,
  ExportPipelineOptions,
  ExportTimeRange,
  JsonExportMode,
  MermaidExportMode,
  TraceExportFilter,
  TraceExportFormat,
  TraceExportTransform,
  ExportTraceOptions
} from './export/index.js';
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configValidationError(message: string, context: Readonly<Record<string, unknown>> = {}): RecordingError {
  return new RecordingError(message, {
    code: 'GHOSTTRACE_CONFIG_INVALID',
    context
  });
}

function assertConfigRecord(config: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(config)) {
    throw configValidationError('GhostTrace config must be an object', {
      actualType: config === null ? 'null' : typeof config
    });
  }

  const unknownKeys = Object.keys(config).filter((key) => !GHOSTTRACE_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw configValidationError(`GhostTrace config contains unknown key(s): ${unknownKeys.join(', ')}`, {
      keys: unknownKeys
    });
  }

  return config;
}

function optionalStringConfigField(
  config: Readonly<Record<string, unknown>>,
  field: string
): string | undefined {
  const value = config[field];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw configValidationError(`GhostTrace config ${field} must be a string`, {
      field,
      actualType: value === null ? 'null' : typeof value
    });
  }

  return value;
}

function optionalMetadataConfigField(
  config: Readonly<Record<string, unknown>>,
  field: string
): TraceMetadata | undefined {
  const value = config[field];
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw configValidationError(`GhostTrace config ${field} must be an object`, {
      field,
      actualType: value === null ? 'null' : typeof value
    });
  }

  return { ...value };
}

function optionalPluginConfigField(
  config: Readonly<Record<string, unknown>>
): readonly GhostTracePlugin[] | undefined {
  const value = config.plugins;
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw configValidationError('GhostTrace config plugins must be an array', {
      field: 'plugins',
      actualType: value === null ? 'null' : typeof value
    });
  }

  return normalizePlugins(value as readonly GhostTracePlugin[]);
}

function pluginProvidedInterceptors(plugins: readonly GhostTracePlugin[] | undefined): readonly Interceptor[] {
  return plugins?.flatMap((plugin) => plugin.interceptors ?? []) ?? [];
}

function optionalInterceptorConfigField(
  config: Readonly<Record<string, unknown>>,
  plugins: readonly GhostTracePlugin[] | undefined
): readonly string[] | undefined {
  const value = config.interceptors;
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw configValidationError('GhostTrace config interceptors must be an array of strings', {
      field: 'interceptors',
      actualType: value === null ? 'null' : typeof value
    });
  }

  const names = value.map((name, index) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw configValidationError(`GhostTrace config interceptor at index ${index} must be a non-empty string`, {
        field: 'interceptors',
        index,
        actualType: name === null ? 'null' : typeof name
      });
    }

    return name;
  });
  const availableNames = registeredInterceptorNames(pluginProvidedInterceptors(plugins));
  const availableNameSet = new Set(availableNames);

  for (const name of names) {
    if (!availableNameSet.has(name)) {
      throw configValidationError(
        `GhostTrace config interceptor "${name}" is not registered. Available interceptors: ${availableNames.join(', ')}`,
        {
          field: 'interceptors',
          interceptor: name,
          availableInterceptors: availableNames
        }
      );
    }
  }

  return names;
}

function optionalRedactionConfigField(
  config: Readonly<Record<string, unknown>>
): RedactionOptions | undefined {
  const value = config.redaction;
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw configValidationError('GhostTrace config redaction must be an object', {
      field: 'redaction',
      actualType: value === null ? 'null' : typeof value
    });
  }

  return normalizeRedactionOptions(value as RedactionOptions);
}

function normalizeConfig(config: GhostTraceConfig): GhostTraceConfig {
  const configRecord = assertConfigRecord(config);
  const plugins = optionalPluginConfigField(configRecord);
  const normalized: {
    traceDir?: string;
    interceptors?: readonly string[];
    redaction?: RedactionOptions;
    plugins?: readonly GhostTracePlugin[];
    metadata?: TraceMetadata;
  } = {};

  const traceDir = optionalStringConfigField(configRecord, 'traceDir');
  if (traceDir !== undefined) {
    normalized.traceDir = traceDir;
  }
  const interceptors = optionalInterceptorConfigField(configRecord, plugins);
  if (interceptors !== undefined) {
    normalized.interceptors = interceptors;
  }
  const redaction = optionalRedactionConfigField(configRecord);
  if (redaction !== undefined) {
    normalized.redaction = redaction;
  }
  if (plugins !== undefined) {
    normalized.plugins = plugins;
  }
  const metadata = optionalMetadataConfigField(configRecord, 'metadata');
  if (metadata !== undefined) {
    normalized.metadata = metadata;
  }

  return normalized;
}

function mergeRecordOptions(config: GhostTraceConfig, options: RecordOptions | undefined): RecordOptions {
  const merged: {
    metadata?: TraceMetadata;
    interceptors?: readonly string[];
    redaction?: RedactionOptions;
    plugins?: readonly GhostTracePlugin[];
    pluginContext?: PluginRuntimeContext;
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
  const mergedPlugins = [...(config.plugins ?? []), ...(options?.plugins ?? [])];
  if (mergedPlugins.length > 0) {
    merged.plugins = mergedPlugins;
  }
  if (options?.pluginContext !== undefined) {
    merged.pluginContext = options.pluginContext;
  }

  return merged;
}

function mergeReplayOptions(config: GhostTraceConfig, options: ReplayOptions | undefined): ReplayOptions {
  const merged: {
    mode?: NonNullable<ReplayOptions['mode']>;
    replayTypes?: NonNullable<ReplayOptions['replayTypes']>;
    timeout?: number;
    plugins?: readonly GhostTracePlugin[];
    pluginContext?: PluginRuntimeContext;
  } = {};

  if (options?.mode !== undefined) {
    merged.mode = options.mode;
  }
  if (options?.replayTypes !== undefined) {
    merged.replayTypes = options.replayTypes;
  }
  if (options?.timeout !== undefined) {
    merged.timeout = options.timeout;
  }

  const mergedPlugins = [...(config.plugins ?? []), ...(options?.plugins ?? [])];
  if (mergedPlugins.length > 0) {
    merged.plugins = mergedPlugins;
  }
  if (options?.pluginContext !== undefined) {
    merged.pluginContext = options.pluginContext;
  }

  return merged;
}

function mergeTracerExportOptions(
  config: GhostTraceConfig,
  options: TracerExportOptions
): ExportTraceOptions {
  const merged = {
    ...options,
    plugins: [...(config.plugins ?? []), ...(options.plugins ?? [])]
  } as ExportTraceOptions;

  if (merged.plugins?.length === 0) {
    delete (merged as { plugins?: readonly GhostTracePlugin[] }).plugins;
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

/** Loads, validates, checksum-checks, and migrates a GhostTrace trace file. */
export async function loadTrace<TSpan extends Span = Span>(path: string): Promise<Trace<TSpan>> {
  return loadValidatedTrace<TSpan>(path, 'loadTrace');
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
  let tracerApi: Tracer;

  tracerApi = {
    config: normalizedConfig,
    record: (name, fn, options) => record(name, fn, {
      ...mergeRecordOptions(normalizedConfig, options),
      pluginContext: {
        tracer: tracerApi,
        config: normalizedConfig
      }
    }),
    replay: (trace, fn, options) => replay(trace, fn, {
      ...mergeReplayOptions(normalizedConfig, options),
      pluginContext: {
        tracer: tracerApi,
        config: normalizedConfig
      }
    }),
    exportTrace: (trace, options) => exportTrace(trace, {
      ...mergeTracerExportOptions(normalizedConfig, options),
      pluginContext: {
        tracer: tracerApi,
        config: normalizedConfig
      }
    }),
    defineConfig
  };

  return tracerApi;
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
  exportHtml,
  exportJson,
  exportMarkdown,
  exportMermaid,
  exportTrace,
  loadTrace,
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
  registerPlugin,
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
