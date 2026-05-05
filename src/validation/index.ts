import * as fsPromises from 'node:fs/promises';
import { TraceValidationError } from '../core/errors.js';
import { SpanType, type Span, type Trace } from '../core/types.js';
import { computeTraceChecksum, isFormattedTraceChecksum, verifyTraceChecksum } from './checksum.js';
import { migrateTraceVersion } from './migrations.js';

/** Severity assigned to a trace validation issue. */
export type TraceValidationIssueSeverity = 'error' | 'warning';

/** Machine-readable validation issue emitted by trace validation. */
export interface TraceValidationIssue {
  /** Stable issue code for programmatic assertions. */
  readonly code: string;
  /** JSONPath-like location of the issue. */
  readonly path: string;
  /** Human-readable diagnostic message. */
  readonly message: string;
  /** Whether the issue invalidates the trace. */
  readonly severity: TraceValidationIssueSeverity;
  /** Additional structured diagnostics. */
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Result returned by trace validation APIs. */
export interface TraceValidationResult<TSpan extends Span = Span> {
  /** True when no error-severity issues were found. */
  readonly valid: boolean;
  /** Error-severity validation issues. */
  readonly errors: readonly TraceValidationIssue[];
  /** Warning-severity validation issues. */
  readonly warnings: readonly TraceValidationIssue[];
  /** Migrated trace when validation succeeds. */
  readonly trace?: Trace<TSpan>;
}

interface SpanReference {
  readonly path: string;
  readonly id?: string;
  readonly parentId?: string | null;
}

type TraceInput<TSpan extends Span = Span> = Trace<TSpan> | string;

const VALID_SPAN_TYPE_VALUES: readonly string[] = Object.values(SpanType);
const VALID_SPAN_TYPE_SET: ReadonlySet<string> = new Set(VALID_SPAN_TYPE_VALUES);
const REQUIRED_TRACE_FIELDS = ['id', 'name', 'version', 'startTime', 'endTime', 'duration', 'spans', 'metadata'] as const;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function hasOwnProperty(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function issue(
  code: string,
  path: string,
  message: string,
  severity: TraceValidationIssueSeverity,
  context?: Readonly<Record<string, unknown>>
): TraceValidationIssue {
  const validationIssue: {
    code: string;
    path: string;
    message: string;
    severity: TraceValidationIssueSeverity;
    context?: Readonly<Record<string, unknown>>;
  } = {
    code,
    path,
    message,
    severity
  };

  if (context !== undefined) {
    validationIssue.context = context;
  }

  return validationIssue;
}

function addError(
  issues: TraceValidationIssue[],
  code: string,
  path: string,
  message: string,
  context?: Readonly<Record<string, unknown>>
): void {
  issues.push(issue(code, path, message, 'error', context));
}

function addWarning(
  issues: TraceValidationIssue[],
  code: string,
  path: string,
  message: string,
  context?: Readonly<Record<string, unknown>>
): void {
  issues.push(issue(code, path, message, 'warning', context));
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

  addError(issues, 'TRACE_REQUIRED_FIELD_MISSING', `${path}.${field}`, `${path}.${field} is required`);
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
    addError(
      issues,
      'TRACE_FIELD_TYPE_INVALID',
      `${path}.${field}`,
      `${path}.${field} must be ${options.nonEmpty === true ? 'a non-empty string' : 'a string'}`,
      { actualType: value === null ? 'null' : typeof value }
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
    addError(
      issues,
      'TRACE_FIELD_TYPE_INVALID',
      `${path}.${field}`,
      `${path}.${field} must be a finite number`,
      { actualType: value === null ? 'null' : typeof value }
    );
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
    addError(
      issues,
      'TRACE_FIELD_TYPE_INVALID',
      `${path}.${field}`,
      `${path}.${field} must be an object`,
      { actualType: record[field] === null ? 'null' : typeof record[field] }
    );
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
    addError(
      issues,
      'TRACE_FIELD_TYPE_INVALID',
      `${path}.parentId`,
      `${path}.parentId must be a string or null`
    );
  }
}

function validateSpanTypeField(
  span: Readonly<Record<string, unknown>>,
  path: string,
  issues: TraceValidationIssue[]
): void {
  if (!hasOwnProperty(span, 'type')) {
    return;
  }

  const spanType = span.type;
  if (typeof spanType !== 'string') {
    addError(issues, 'TRACE_FIELD_TYPE_INVALID', `${path}.type`, `${path}.type must be a string`);
    return;
  }

  if (!VALID_SPAN_TYPE_SET.has(spanType)) {
    addWarning(
      issues,
      'TRACE_SPAN_TYPE_UNKNOWN',
      `${path}.type`,
      `${path}.type is not a known GhostTrace span type: ${VALID_SPAN_TYPE_VALUES.join(', ')}`,
      { actual: spanType, expected: VALID_SPAN_TYPE_VALUES }
    );
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
    addError(issues, 'TRACE_FIELD_TYPE_INVALID', `${path}.error`, `${path}.error must be an object or null`);
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

function validateDurationInvariants(
  span: Readonly<Record<string, unknown>>,
  path: string,
  issues: TraceValidationIssue[]
): void {
  if (
    typeof span.startTime !== 'number' ||
    typeof span.endTime !== 'number' ||
    typeof span.duration !== 'number' ||
    !Number.isFinite(span.startTime) ||
    !Number.isFinite(span.endTime) ||
    !Number.isFinite(span.duration)
  ) {
    return;
  }

  if (span.endTime < span.startTime) {
    addError(
      issues,
      'TRACE_SPAN_TIME_INVALID',
      `${path}.endTime`,
      `${path}.endTime must be greater than or equal to ${path}.startTime`
    );
    return;
  }

}

function validateChildrenField(
  span: Readonly<Record<string, unknown>>,
  path: string,
  issues: TraceValidationIssue[],
  references: SpanReference[]
): void {
  if (!hasOwnProperty(span, 'children')) {
    return;
  }

  const children = span.children;
  if (!Array.isArray(children)) {
    addError(issues, 'TRACE_FIELD_TYPE_INVALID', `${path}.children`, `${path}.children must be an array`);
    return;
  }

  validateSpanArray(children, `${path}.children`, issues, references);
}

function validateSpanShape(
  value: unknown,
  path: string,
  issues: TraceValidationIssue[],
  references: SpanReference[]
): void {
  if (!isRecord(value)) {
    addError(issues, 'TRACE_FIELD_TYPE_INVALID', path, `${path} must be an object`);
    return;
  }

  for (const field of REQUIRED_SPAN_FIELDS) {
    requireField(value, path, field, issues);
  }

  validateStringField(value, path, 'id', issues, { nonEmpty: true });
  validateParentIdField(value, path, issues);
  validateSpanTypeField(value, path, issues);
  validateStringField(value, path, 'name', issues);
  validateNumberField(value, path, 'startTime', issues);
  validateNumberField(value, path, 'endTime', issues);
  validateNumberField(value, path, 'duration', issues);
  validateDurationInvariants(value, path, issues);
  validateChildrenField(value, path, issues, references);
  validateErrorField(value, path, issues);
  validateRecordField(value, path, 'metadata', issues);
  references.push(spanReference(value, path));
}

function validateSpanArray(
  spans: readonly unknown[],
  path: string,
  issues: TraceValidationIssue[],
  references: SpanReference[]
): void {
  let previousStartTime: number | undefined;

  for (const [index, spanValue] of spans.entries()) {
    const spanPath = `${path}[${index}]`;
    if (
      isRecord(spanValue) &&
      typeof spanValue.startTime === 'number' &&
      Number.isFinite(spanValue.startTime)
    ) {
      if (previousStartTime !== undefined && spanValue.startTime < previousStartTime) {
        addError(
          issues,
          'TRACE_SPAN_SEQUENCE_NON_MONOTONIC',
          `${spanPath}.startTime`,
          `${spanPath}.startTime must be greater than or equal to the previous span startTime`
        );
      }
      previousStartTime = spanValue.startTime;
    }

    validateSpanShape(spanValue, spanPath, issues, references);
  }
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
    addError(
      issues,
      'TRACE_PARENT_ID_DANGLING',
      `${reference.path}.parentId`,
      `${reference.path}.parentId references missing span "${reference.parentId}"`
    );
  }
}

function validateTraceTiming(trace: Readonly<Record<string, unknown>>, issues: TraceValidationIssue[]): void {
  if (
    typeof trace.startTime !== 'number' ||
    typeof trace.endTime !== 'number' ||
    typeof trace.duration !== 'number' ||
    !Number.isFinite(trace.startTime) ||
    !Number.isFinite(trace.endTime) ||
    !Number.isFinite(trace.duration)
  ) {
    return;
  }

  if (trace.endTime < trace.startTime) {
    addError(
      issues,
      'TRACE_TIME_INVALID',
      '$.endTime',
      '$.endTime must be greater than or equal to $.startTime'
    );
    return;
  }

  if (trace.duration !== trace.endTime - trace.startTime) {
    addError(
      issues,
      'TRACE_DURATION_MISMATCH',
      '$.duration',
      '$.duration must equal $.endTime - $.startTime'
    );
  }
}

function validateChecksumField(trace: Readonly<Record<string, unknown>>, issues: TraceValidationIssue[]): void {
  if (!hasOwnProperty(trace, 'checksum')) {
    return;
  }

  if (!isFormattedTraceChecksum(trace.checksum)) {
    addError(
      issues,
      'TRACE_CHECKSUM_INVALID',
      '$.checksum',
      '$.checksum must be formatted as sha256:<64 lowercase hex characters>'
    );
    return;
  }

  const traceLike = trace as unknown as Trace;
  if (!verifyTraceChecksum(traceLike)) {
    addError(issues, 'TRACE_CHECKSUM_MISMATCH', '$.checksum', '$.checksum does not match canonical trace JSON', {
      expected: `sha256:${computeTraceChecksum(traceLike)}`,
      actual: trace.checksum
    });
  }
}

function validationResult<TSpan extends Span>(
  issues: readonly TraceValidationIssue[],
  trace?: Trace<TSpan>
): TraceValidationResult<TSpan> {
  const errors = issues.filter((validationIssue) => validationIssue.severity === 'error');
  const warnings = issues.filter((validationIssue) => validationIssue.severity === 'warning');
  const result: {
    valid: boolean;
    errors: readonly TraceValidationIssue[];
    warnings: readonly TraceValidationIssue[];
    trace?: Trace<TSpan>;
  } = {
    valid: errors.length === 0,
    errors,
    warnings
  };

  if (errors.length === 0 && trace !== undefined) {
    result.trace = trace;
  }

  return result;
}

function validateTraceObject<TSpan extends Span>(value: unknown): TraceValidationResult<TSpan> {
  const issues: TraceValidationIssue[] = [];
  const references: SpanReference[] = [];

  if (!isRecord(value)) {
    return validationResult([
      issue('TRACE_FIELD_TYPE_INVALID', '$', '$ must be an object', 'error', {
        actualType: value === null ? 'null' : typeof value
      })
    ]);
  }

  for (const field of REQUIRED_TRACE_FIELDS) {
    requireField(value, '$', field, issues);
  }

  validateStringField(value, '$', 'id', issues, { nonEmpty: true });
  validateStringField(value, '$', 'name', issues);
  validateStringField(value, '$', 'version', issues);
  validateNumberField(value, '$', 'startTime', issues);
  validateNumberField(value, '$', 'endTime', issues);
  validateNumberField(value, '$', 'duration', issues);
  validateTraceTiming(value, issues);

  if (hasOwnProperty(value, 'spans')) {
    if (!Array.isArray(value.spans)) {
      addError(issues, 'TRACE_FIELD_TYPE_INVALID', '$.spans', '$.spans must be an array');
    } else {
      validateSpanArray(value.spans, '$.spans', issues, references);
    }
  }

  validateRecordField(value, '$', 'metadata', issues);
  validateParentReferences(references, issues);

  if (typeof value.version === 'string') {
    migrateTraceVersion(value as unknown as Trace<TSpan>);
  }

  validateChecksumField(value, issues);

  if (issues.some((validationIssue) => validationIssue.severity === 'error')) {
    return validationResult(issues);
  }

  return validationResult(
    issues,
    typeof value.version === 'string' ? migrateTraceVersion(value as unknown as Trace<TSpan>) : undefined
  );
}

function fileIssue(code: string, filePath: string, message: string, cause?: unknown): TraceValidationResult {
  const context: Record<string, unknown> = { filePath };
  if (cause instanceof Error) {
    context.reason = cause.message;
  }

  return validationResult([issue(code, '$', message, 'error', context)]);
}

async function validateTraceFile(filePath: string): Promise<TraceValidationResult> {
  let text: string;
  try {
    text = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return fileIssue('TRACE_FILE_NOT_FOUND', filePath, `Trace file not found: ${filePath}`, error);
    }

    return fileIssue('TRACE_FILE_READ_ERROR', filePath, `Unable to read trace file: ${filePath}`, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return fileIssue('TRACE_JSON_PARSE_ERROR', filePath, `Unable to parse trace file ${filePath} as JSON`, error);
  }

  return validateTraceObject(parsed);
}

function validationFailureMessage(role: string, result: TraceValidationResult): string {
  return `${role} trace is invalid: ${result.errors.map((error) => `${error.path} ${error.message}`).join('; ')}`;
}

function throwIfInvalid(role: string, result: TraceValidationResult): Trace {
  if (result.valid && result.trace !== undefined) {
    return result.trace;
  }

  throw new TraceValidationError(validationFailureMessage(role, result), {
    code: 'TRACE_VALIDATION_FAILED',
    context: {
      role,
      validationErrors: result.errors
    }
  });
}

/** Validates a trace file path and returns machine-readable issues. */
export function validateTrace(path: string): Promise<TraceValidationResult>;
/** Validates an in-memory trace-like object and returns machine-readable issues. */
export function validateTrace<TSpan extends Span>(trace: Trace<TSpan> | unknown): TraceValidationResult<TSpan>;
export function validateTrace<TSpan extends Span>(
  input: TraceInput<TSpan> | unknown
): TraceValidationResult<TSpan> | Promise<TraceValidationResult> {
  if (typeof input === 'string') {
    return validateTraceFile(input);
  }

  return validateTraceObject<TSpan>(input);
}

/** Loads, validates, and migrates a trace object or path for internal APIs that need a concrete trace. */
export async function loadValidatedTrace<TSpan extends Span>(
  input: TraceInput<TSpan>,
  role: string
): Promise<Trace<TSpan>> {
  if (typeof input === 'string') {
    return throwIfInvalid(role, await validateTraceFile(input)) as Trace<TSpan>;
  }

  return validateTraceForUse(input, role);
}

/** Validates and migrates an in-memory trace for internal APIs that remain synchronous. */
export function validateTraceForUse<TSpan extends Span>(trace: Trace<TSpan>, role: string): Trace<TSpan> {
  return throwIfInvalid(role, validateTraceObject<TSpan>(trace)) as Trace<TSpan>;
}

export {
  computeTraceChecksum,
  withTraceChecksum,
  verifyTraceChecksum,
  type ChecksummedTrace
} from './checksum.js';
export { canonicalJsonStringify, toSerializableTrace } from './canonical.js';
export {
  assertSupportedTraceVersion,
  isSupportedTraceVersion,
  migrateTraceVersion
} from './migrations.js';
