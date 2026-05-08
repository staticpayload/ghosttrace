import * as fsPromises from 'node:fs/promises';
import { clearTimeout as clearNativeTimeout, setTimeout as setNativeTimeout } from 'node:timers';
import { createTraceContext, runWithTraceContext } from '../core/context.js';
import { ReplayMismatchError, TraceValidationError } from '../core/errors.js';
import {
  SpanType,
  type GhostTraceConfig,
  type ReplayOptions,
  type ReplayResult,
  type Span,
  type Trace,
  type TraceableFunction
} from '../core/types.js';
import {
  dbInterceptor,
  envInterceptor,
  fsInterceptor,
  httpInterceptor,
  performanceInterceptor,
  queueInterceptor,
  randomInterceptor,
  timerInterceptor,
  type Interceptor,
  type Teardown
} from '../interceptors/index.js';
import { createPluginRuntime, pluginInterceptors, runTracePluginHooks } from '../plugins/index.js';
import {
  validateTrace as validateTraceInput,
  type TraceValidationResult as IntegrityTraceValidationResult
} from '../validation/index.js';
import { createReplayStore } from './store.js';

interface ReplayInterceptorEntry {
  readonly type: SpanType;
  readonly interceptor: Interceptor;
}

const replayInterceptors: readonly ReplayInterceptorEntry[] = [
  { type: SpanType.Timer, interceptor: timerInterceptor },
  { type: SpanType.Random, interceptor: randomInterceptor },
  { type: SpanType.Env, interceptor: envInterceptor },
  { type: SpanType.Http, interceptor: httpInterceptor },
  { type: SpanType.Fs, interceptor: fsInterceptor },
  { type: SpanType.Db, interceptor: dbInterceptor },
  { type: SpanType.Queue, interceptor: queueInterceptor },
  { type: SpanType.Performance, interceptor: performanceInterceptor }
];

const builtInReplaySpanTypes: ReadonlySet<SpanType> = new Set(replayInterceptors.map((entry) => entry.type));

let nextReplaySessionSequence = 1;

function monotonicNow(): number {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function nextReplaySessionId(traceId: string): string {
  const sequence = nextReplaySessionSequence;
  nextReplaySessionSequence += 1;
  return `${traceId}:replay:${sequence}`;
}

function configFromReplayOptions(options: ReplayOptions): GhostTraceConfig {
  const config: {
    plugins?: NonNullable<ReplayOptions['plugins']>;
  } = {};

  if (options.plugins !== undefined) {
    config.plugins = options.plugins;
  }

  return config;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

interface TraceValidationIssue {
  readonly path: string;
  readonly message: string;
}

interface TraceShapeOptions {
  readonly allowCustomSpanTypes?: boolean;
}

interface SpanReference {
  readonly path: string;
  readonly id?: string;
  readonly parentId?: string | null;
}

const VALID_SPAN_TYPE_VALUES: readonly string[] = Object.values(SpanType);
const VALID_SPAN_TYPE_SET: ReadonlySet<string> = new Set(VALID_SPAN_TYPE_VALUES);
const VALID_OUTPUT_TYPE_VALUES = ['resolve', 'reject', 'return', 'throw'] as const;
const VALID_OUTPUT_TYPE_SET: ReadonlySet<string> = new Set(VALID_OUTPUT_TYPE_VALUES);
const OUTPUT_TYPE_REQUIRED_SPAN_TYPES: ReadonlySet<string> = new Set([SpanType.Db, SpanType.Queue]);
const INTEGRITY_VALIDATION_ERROR_CODES: ReadonlySet<string> = new Set([
  'TRACE_CHECKSUM_MISSING',
  'TRACE_CHECKSUM_INVALID',
  'TRACE_CHECKSUM_MISMATCH'
]);
const REQUIRED_SPAN_FIELDS = [
  'id',
  'parentId',
  'type',
  'name',
  'startTime',
  'endTime',
  'duration',
  'input',
  'output',
  'children',
  'error',
  'metadata'
] as const;

function traceShapeError(filePath: string, reason: string, context: Readonly<Record<string, unknown>> = {}): TraceValidationError {
  return new TraceValidationError(`Invalid replay trace file ${filePath}: ${reason}`, {
    code: 'GHOSTTRACE_REPLAY_TRACE_INVALID',
    context: {
      filePath,
      reason,
      ...context
    }
  });
}

function traceShapeIssuesError(filePath: string, issues: readonly TraceValidationIssue[]): TraceValidationError {
  const reason = `${issues.length} validation error${issues.length === 1 ? '' : 's'}`;

  return traceShapeError(filePath, `${reason}: ${issues.map((issue) => issue.message).join('; ')}`, {
    validationErrors: issues.map((issue) => ({
      path: issue.path,
      message: issue.message
    }))
  });
}

function integrityIssuesError(filePath: string, result: IntegrityTraceValidationResult): TraceValidationError {
  const reason = result.errors.map((error) => `${error.path} ${error.message}`).join('; ');

  return traceShapeError(filePath, reason, {
    validationErrors: result.errors.map((error) => ({
      code: error.code,
      path: error.path,
      message: error.message
    }))
  });
}

function validatesWithIntegrity<TSpan extends Span>(
  value: unknown,
  filePath: string
): Trace<TSpan> | unknown {
  const result = validateTraceInput<TSpan>(value) as IntegrityTraceValidationResult<TSpan>;

  if (!result.valid && result.errors.some((error) => INTEGRITY_VALIDATION_ERROR_CODES.has(error.code))) {
    throw integrityIssuesError(filePath, result);
  }

  return result.valid && result.trace !== undefined ? result.trace : value;
}

function hasOwnProperty(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function addValidationIssue(issues: TraceValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function requireField(
  record: Readonly<Record<string, unknown>>,
  path: string,
  field: string,
  issues: TraceValidationIssue[]
): boolean {
  if (hasOwnProperty(record, field)) {
    return true;
  }

  addValidationIssue(issues, `${path}.${field}`, `${path}.${field} is required`);
  return false;
}

function validateStringField(
  record: Readonly<Record<string, unknown>>,
  path: string,
  field: string,
  issues: TraceValidationIssue[],
  options: { readonly nonEmpty?: boolean } = {}
): void {
  if (!hasOwnProperty(record, field)) {
    return;
  }

  const value = record[field];
  if (typeof value !== 'string' || (options.nonEmpty === true && value.length === 0)) {
    addValidationIssue(
      issues,
      `${path}.${field}`,
      `${path}.${field} must be ${options.nonEmpty === true ? 'a non-empty string' : 'a string'}`
    );
  }
}

function validateNumberField(
  record: Readonly<Record<string, unknown>>,
  path: string,
  field: string,
  issues: TraceValidationIssue[]
): void {
  if (!hasOwnProperty(record, field)) {
    return;
  }

  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addValidationIssue(issues, `${path}.${field}`, `${path}.${field} must be a finite number`);
  }
}

function validateRecordField(
  record: Readonly<Record<string, unknown>>,
  path: string,
  field: string,
  issues: TraceValidationIssue[]
): void {
  if (!hasOwnProperty(record, field)) {
    return;
  }

  if (!isRecord(record[field])) {
    addValidationIssue(issues, `${path}.${field}`, `${path}.${field} must be an object`);
  }
}

function validateParentIdField(
  span: Readonly<Record<string, unknown>>,
  path: string,
  issues: TraceValidationIssue[]
): void {
  if (!hasOwnProperty(span, 'parentId')) {
    return;
  }

  const parentId = span.parentId;
  if (parentId !== null && typeof parentId !== 'string') {
    addValidationIssue(issues, `${path}.parentId`, `${path}.parentId must be a string or null`);
  }
}

function validateSpanTypeField(
  span: Readonly<Record<string, unknown>>,
  path: string,
  issues: TraceValidationIssue[],
  options: TraceShapeOptions
): void {
  if (!hasOwnProperty(span, 'type')) {
    return;
  }

  const spanType = span.type;
  if (typeof spanType !== 'string') {
    addValidationIssue(issues, `${path}.type`, `${path}.type must be a string`);
    return;
  }
  if (!VALID_SPAN_TYPE_SET.has(spanType)) {
    if (options.allowCustomSpanTypes === true && spanType.length > 0) {
      return;
    }

    addValidationIssue(
      issues,
      `${path}.type`,
      `${path}.type must be one of: ${VALID_SPAN_TYPE_VALUES.join(', ')}`
    );
  }
}

function validateChildrenField(
  span: Readonly<Record<string, unknown>>,
  path: string,
  issues: TraceValidationIssue[],
  references: SpanReference[],
  options: TraceShapeOptions
): void {
  if (!hasOwnProperty(span, 'children')) {
    return;
  }

  const children = span.children;
  if (!Array.isArray(children)) {
    addValidationIssue(issues, `${path}.children`, `${path}.children must be an array`);
    return;
  }

  for (const [index, child] of children.entries()) {
    validateSpanShape(child, `${path}.children[${index}]`, issues, references, options);
  }
}

function validateErrorField(
  span: Readonly<Record<string, unknown>>,
  path: string,
  issues: TraceValidationIssue[]
): void {
  if (!hasOwnProperty(span, 'error')) {
    return;
  }

  const error = span.error;
  if (error !== null && !isRecord(error)) {
    addValidationIssue(issues, `${path}.error`, `${path}.error must be an object or null`);
  }
}

function validateOutputTypeField(
  span: Readonly<Record<string, unknown>>,
  path: string,
  issues: TraceValidationIssue[]
): void {
  if (!hasOwnProperty(span, 'output') || typeof span.type !== 'string') {
    return;
  }
  if (!OUTPUT_TYPE_REQUIRED_SPAN_TYPES.has(span.type)) {
    return;
  }

  const output = span.output;
  if (!isRecord(output)) {
    addValidationIssue(issues, `${path}.output`, `${path}.output must be an object with a replay outcome type`);
    return;
  }
  if (!hasOwnProperty(output, 'type')) {
    addValidationIssue(issues, `${path}.output.type`, `${path}.output.type is required`);
    return;
  }
  if (typeof output.type !== 'string' || !VALID_OUTPUT_TYPE_SET.has(output.type)) {
    addValidationIssue(
      issues,
      `${path}.output.type`,
      `${path}.output.type must be one of: ${VALID_OUTPUT_TYPE_VALUES.join(', ')}`
    );
  }
}

function spanReference(span: Readonly<Record<string, unknown>>, path: string): SpanReference {
  const reference: { path: string; id?: string; parentId?: string | null } = { path };

  if (typeof span.id === 'string' && span.id.length > 0) {
    reference.id = span.id;
  }
  if (span.parentId === null || typeof span.parentId === 'string') {
    reference.parentId = span.parentId;
  }

  return reference;
}

function validateSpanShape(
  value: unknown,
  path: string,
  issues: TraceValidationIssue[],
  references: SpanReference[],
  options: TraceShapeOptions
): void {
  if (!isRecord(value)) {
    addValidationIssue(issues, path, `${path} must be an object`);
    return;
  }

  for (const field of REQUIRED_SPAN_FIELDS) {
    requireField(value, path, field, issues);
  }

  validateStringField(value, path, 'id', issues, { nonEmpty: true });
  validateParentIdField(value, path, issues);
  validateSpanTypeField(value, path, issues, options);
  validateStringField(value, path, 'name', issues);
  validateNumberField(value, path, 'startTime', issues);
  validateNumberField(value, path, 'endTime', issues);
  validateNumberField(value, path, 'duration', issues);
  validateOutputTypeField(value, path, issues);
  validateChildrenField(value, path, issues, references, options);
  validateErrorField(value, path, issues);
  validateRecordField(value, path, 'metadata', issues);
  references.push(spanReference(value, path));
}

function validateParentReferences(references: readonly SpanReference[], issues: TraceValidationIssue[]): void {
  const spanIds = new Set(references.flatMap((reference) => (reference.id === undefined ? [] : [reference.id])));
  const reportedReferences = new Set<string>();

  for (const reference of references) {
    if (typeof reference.parentId !== 'string' || spanIds.has(reference.parentId)) {
      continue;
    }

    const reportKey = `${reference.path}:${reference.parentId}`;
    if (reportedReferences.has(reportKey)) {
      continue;
    }

    reportedReferences.add(reportKey);
    addValidationIssue(
      issues,
      `${reference.path}.parentId`,
      `${reference.path}.parentId references missing span "${reference.parentId}"`
    );
  }
}

function assertTraceShape<TSpan extends Span>(
  value: unknown,
  filePath: string,
  options: TraceShapeOptions = {}
): asserts value is Trace<TSpan> {
  const issues: TraceValidationIssue[] = [];
  const references: SpanReference[] = [];

  if (!isRecord(value)) {
    throw traceShapeError(filePath, 'trace JSON must contain an object');
  }

  for (const field of ['id', 'name', 'version', 'startTime', 'endTime', 'duration', 'spans', 'metadata']) {
    requireField(value, 'trace', field, issues);
  }

  validateStringField(value, 'trace', 'id', issues, { nonEmpty: true });
  validateStringField(value, 'trace', 'name', issues);
  validateStringField(value, 'trace', 'version', issues);
  validateNumberField(value, 'trace', 'startTime', issues);
  validateNumberField(value, 'trace', 'endTime', issues);
  validateNumberField(value, 'trace', 'duration', issues);

  if (hasOwnProperty(value, 'spans')) {
    if (!Array.isArray(value.spans)) {
      addValidationIssue(issues, 'trace.spans', 'trace.spans must be an array');
    } else {
      for (const [index, span] of value.spans.entries()) {
        validateSpanShape(span, `trace.spans[${index}]`, issues, references, options);
      }
    }
  }

  validateRecordField(value, 'trace', 'metadata', issues);
  validateParentReferences(references, issues);

  if (issues.length > 0) {
    throw traceShapeIssuesError(filePath, issues);
  }
}

async function loadReplayTrace<TSpan extends Span>(
  filePath: string,
  options: TraceShapeOptions = {}
): Promise<Trace<TSpan>> {
  let text: string;

  try {
    text = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new TraceValidationError(`Replay trace file not found: ${filePath}`, {
        code: 'GHOSTTRACE_REPLAY_TRACE_NOT_FOUND',
        context: { filePath },
        cause: error
      });
    }

    throw new TraceValidationError(`Unable to read replay trace file: ${filePath}`, {
      code: 'GHOSTTRACE_REPLAY_TRACE_READ_ERROR',
      context: {
        filePath,
        reason: error instanceof Error ? error.message : String(error)
      },
      cause: error
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TraceValidationError(`Unable to parse replay trace file ${filePath} as JSON`, {
      code: 'GHOSTTRACE_REPLAY_TRACE_PARSE_ERROR',
      context: {
        filePath,
        reason: error instanceof Error ? error.message : String(error)
      },
      cause: error
    });
  }

  const validatedTrace = validatesWithIntegrity<TSpan>(parsed, filePath);
  assertTraceShape<TSpan>(validatedTrace, filePath, options);
  return validatedTrace;
}

function shouldInstallReplayInterceptor(type: SpanType, options: ReplayOptions): boolean {
  if (options.mode !== 'partial') {
    return true;
  }

  return (options.replayTypes ?? []).includes(type);
}

function shouldInstallPluginReplayInterceptor(options: ReplayOptions): boolean {
  if (options.mode !== 'partial') {
    return true;
  }

  return (options.replayTypes ?? []).some((type) => !builtInReplaySpanTypes.has(type));
}

function installReplayInterceptors(
  options: ReplayOptions,
  additionalInterceptors: readonly Interceptor[] = []
): readonly Teardown[] {
  const teardowns: Teardown[] = [];

  for (const entry of replayInterceptors) {
    if (!shouldInstallReplayInterceptor(entry.type, options) || !entry.interceptor.isAvailable()) {
      continue;
    }

    teardowns.push(entry.interceptor.install({ addSpan: () => undefined }));
  }
  if (shouldInstallPluginReplayInterceptor(options)) {
    for (const interceptor of additionalInterceptors) {
      if (!interceptor.isAvailable()) {
        continue;
      }

      teardowns.push(interceptor.install({ addSpan: () => undefined }));
    }
  }

  return teardowns;
}

function teardownReplayInterceptors(teardowns: readonly Teardown[]): void {
  for (const teardown of [...teardowns].reverse()) {
    teardown();
  }
}

function summarizeUnmatchedSpan(span: Span): Record<string, string> {
  return {
    id: span.id,
    type: span.type,
    name: span.name
  };
}

function normalizeReplayTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new ReplayMismatchError('Replay timeout must be a positive finite number of milliseconds', {
      code: 'GHOSTTRACE_REPLAY_TIMEOUT_INVALID',
      context: { timeout }
    });
  }

  return timeout;
}

function replayTimeoutError(trace: Trace, timeout: number): ReplayMismatchError {
  return new ReplayMismatchError(`Replay timed out after ${timeout}ms`, {
    code: 'GHOSTTRACE_REPLAY_TIMEOUT',
    traceId: trace.id,
    context: { timeout }
  });
}

function executeWithReplayTimeout<TOutput>(
  trace: Trace,
  fn: TraceableFunction<TOutput>,
  timeout: number | undefined
): Promise<Awaited<TOutput>> {
  if (timeout === undefined) {
    return Promise.resolve().then(fn) as Promise<Awaited<TOutput>>;
  }

  return new Promise<Awaited<TOutput>>((resolve, reject) => {
    let settled = false;
    const timeoutHandle = setNativeTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(replayTimeoutError(trace, timeout));
    }, timeout);

    (Promise.resolve().then(fn) as Promise<Awaited<TOutput>>).then(
      (value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearNativeTimeout(timeoutHandle);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        clearNativeTimeout(timeoutHandle);
        reject(error);
      }
    );
  });
}

/** Replays deterministic side-effect spans against a trace object. */
export async function replay<TOutput, TSpan extends Span = Span>(
  traceInput: Trace<TSpan> | string,
  fn: TraceableFunction<TOutput>,
  options: ReplayOptions = {}
): Promise<ReplayResult<Awaited<TOutput>, TSpan>> {
  const pluginRuntimeOptions: {
    plugins?: NonNullable<ReplayOptions['plugins']>;
    pluginContext?: NonNullable<ReplayOptions['pluginContext']>;
    config: GhostTraceConfig;
  } = {
    config: configFromReplayOptions(options)
  };
  if (options.plugins !== undefined) {
    pluginRuntimeOptions.plugins = options.plugins;
  }
  if (options.pluginContext !== undefined) {
    pluginRuntimeOptions.pluginContext = options.pluginContext;
  }
  const pluginRuntime = createPluginRuntime(pluginRuntimeOptions);
  const additionalPluginInterceptors = pluginInterceptors(pluginRuntime);
  const traceShapeOptions = {
    allowCustomSpanTypes: additionalPluginInterceptors.length > 0
  };
  const loadedTrace = typeof traceInput === 'string'
    ? await loadReplayTrace<TSpan>(traceInput, traceShapeOptions)
    : traceInput;
  if (typeof traceInput !== 'string') {
    assertTraceShape<TSpan>(loadedTrace, '<trace object>', traceShapeOptions);
  }
  const timeout = normalizeReplayTimeout(options.timeout);
  const trace = await runTracePluginHooks(pluginRuntime, 'beforeReplay', loadedTrace, {
    operation: 'replay'
  }) as Trace<TSpan>;

  const replayStore = createReplayStore(trace, options);
  const context = createTraceContext({
    traceId: trace.id,
    sessionId: nextReplaySessionId(trace.id),
    mode: 'replay',
    metadata: trace.metadata,
    replayStore
  });
  const startedAt = monotonicNow();
  let output: Awaited<TOutput>;
  let replayResultTrace: Trace<TSpan> = trace;

  await runWithTraceContext(context, async () => {
    const teardowns = installReplayInterceptors(options, additionalPluginInterceptors);

    try {
      output = await executeWithReplayTimeout(trace, fn, timeout);
      if (replayStore.mode === 'strict') {
        const unmatchedSpans = replayStore.unmatchedSpans();
        if (unmatchedSpans.length > 0) {
          throw new ReplayMismatchError(
            `Strict replay did not consume ${unmatchedSpans.length} recorded replay span${unmatchedSpans.length === 1 ? '' : 's'}`,
            {
              traceId: trace.id,
              context: {
                unmatchedCount: unmatchedSpans.length,
                unmatchedSpans: unmatchedSpans.map(summarizeUnmatchedSpan)
              }
            }
          );
        }
      }
      replayResultTrace = await runTracePluginHooks(pluginRuntime, 'afterReplay', trace, {
        operation: 'replay'
      }) as Trace<TSpan>;
    } finally {
      teardownReplayInterceptors(teardowns);
    }
  });

  return {
    output: output!,
    trace: replayResultTrace,
    replayTrace: trace,
    spansMatched: replayStore.matchedSpans(),
    originalDuration: trace.duration,
    replayDuration: monotonicNow() - startedAt
  };
}
