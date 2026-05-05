import { sanitizeTraceNameForFilename } from '../core/persistence.js';
import { serialize, type SerializedJsonValue } from '../core/serializer.js';
import { SpanType, type Span, type SpanError, type Trace, type TraceMetadata } from '../core/types.js';

/** Filter shape shared by code-generation features that select spans. */
export interface GenerationFilter {
  /** Span type to include. */
  readonly type?: SpanType | string;
  /** Span name to include, matched exactly for strings or by RegExp. */
  readonly name?: string | RegExp;
}

interface GeneratedSpan {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: SpanType;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  readonly input: SerializedJsonValue;
  readonly output: SerializedJsonValue;
  readonly children: readonly GeneratedSpan[];
  readonly error: SerializedJsonValue | null;
  readonly metadata: SerializedJsonValue;
}

interface GeneratedTrace {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  readonly spans: readonly GeneratedSpan[];
  readonly metadata: SerializedJsonValue;
  readonly checksum?: string;
}

const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield'
]);

/** Returns true when a value is a non-array object record. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escapes a string as a TypeScript string literal. */
export function stringLiteral(value: string): string {
  return JSON.stringify(value) ?? '""';
}

/** Converts a value to pretty JSON suitable for embedding in generated files. */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'undefined';
}

/** Converts an arbitrary value to GhostTrace's JSON-safe serialized representation. */
export function serializedValue(value: unknown): SerializedJsonValue {
  return serialize(value);
}

/** Sanitizes a span name for use as a generated path segment. */
export function pathSegmentFromName(name: string): string {
  return sanitizeTraceNameForFilename(name);
}

/** Builds a valid TypeScript identifier from arbitrary generated names. */
export function identifierFromName(name: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9_$]+/gu, '_')
    .replace(/^[^A-Za-z_$]+/u, '')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  const candidate = sanitized.length === 0 ? 'generated' : sanitized;

  return RESERVED_IDENTIFIERS.has(candidate) ? `${candidate}Value` : candidate;
}

/** Adds a numeric suffix to an identifier until it is unique in the given set. */
export function uniqueIdentifier(baseName: string, usedNames: Set<string>): string {
  let candidate = identifierFromName(baseName);
  let suffix = 2;

  while (usedNames.has(candidate)) {
    candidate = identifierFromName(`${baseName}_${suffix}`);
    suffix += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

/** Tests whether a span matches an optional generation filter. */
export function spanMatchesFilter(span: Span, filter: GenerationFilter | undefined): boolean {
  if (filter?.type !== undefined && span.type !== filter.type) {
    return false;
  }
  if (filter?.name === undefined) {
    return true;
  }
  if (typeof filter.name === 'string') {
    return span.name === filter.name;
  }

  filter.name.lastIndex = 0;
  return filter.name.test(span.name);
}

/** Converts a span to an object safe for generated JSON or TypeScript literals. */
export function generatedSpan(span: Span): GeneratedSpan {
  return {
    id: span.id,
    parentId: span.parentId,
    type: span.type,
    name: span.name,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    input: serializedValue(span.input),
    output: serializedValue(span.output),
    children: span.children.map(generatedSpan),
    error: span.error === null ? null : serializedValue(span.error),
    metadata: serializedValue(span.metadata)
  };
}

/** Converts a trace to an object safe for generated replay test literals. */
export function generatedTrace(trace: Trace): GeneratedTrace {
  const baseTrace = {
    id: trace.id,
    name: trace.name,
    version: trace.version,
    startTime: trace.startTime,
    endTime: trace.endTime,
    duration: trace.duration,
    spans: trace.spans.map(generatedSpan),
    metadata: serializedValue(trace.metadata)
  };

  return trace.checksum === undefined ? baseTrace : { ...baseTrace, checksum: trace.checksum };
}

/** Serializes span error details while preserving null for successful spans. */
export function generatedError(error: SpanError | null): SerializedJsonValue | null {
  return error === null ? null : serializedValue(error);
}

/** Serializes trace metadata for generated fixture payloads. */
export function generatedMetadata(metadata: TraceMetadata): SerializedJsonValue {
  return serializedValue(metadata);
}
