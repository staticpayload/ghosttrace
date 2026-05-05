import { promises as fsPromises } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { ExportError } from './errors.js';
import { serialize, type SerializedJsonValue } from './serializer.js';
import type { RecordedTrace, Span, Trace, TraceSaveTarget } from './types.js';
import { redactTrace, redactValue } from '../redaction/index.js';

const TRACE_FILE_SUFFIX = '.ghosttrace.json';
const SAFE_FILENAME_SEGMENT = /[^a-z0-9._-]+/gu;
const COMBINING_MARK = /[\u0300-\u036f]/gu;
const REPEATED_DASH = /-+/gu;
const EDGE_SEPARATORS = /^[._-]+|[._-]+$/gu;
const TIMESTAMP_FILENAME_SEPARATOR = /[:.]/gu;
const MAX_SAFE_NAME_LENGTH = 80;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidDateTimestamp(timestampMs: number): boolean {
  return Number.isFinite(timestampMs) && Math.abs(timestampMs) <= MAX_VALID_DATE_MS;
}

function metadataTimestampMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestampMs = value.getTime();
    return isValidDateTimestamp(timestampMs) ? timestampMs : undefined;
  }

  if (typeof value === 'number') {
    return isValidDateTimestamp(value) ? value : undefined;
  }

  if (typeof value === 'string') {
    const timestampMs = Date.parse(value);
    return isValidDateTimestamp(timestampMs) ? timestampMs : undefined;
  }

  return undefined;
}

function isoTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function sanitizeTimestampForFilename(timestamp: string): string {
  return timestamp.replace(TIMESTAMP_FILENAME_SEPARATOR, '-');
}

function traceTimestamp(trace: Trace): string {
  return sanitizeTimestampForFilename(isoTimestamp(metadataTimestampMs(trace.metadata.recordedAt) ?? Date.now()));
}

function looksLikeDirectoryTarget(target: string): boolean {
  return target.endsWith('/') || target.endsWith('\\') || extname(target) === '';
}

function resolveSavePath(trace: Trace, target: TraceSaveTarget | undefined): string {
  if (target === undefined) {
    return join(process.cwd(), defaultTraceFileName(trace));
  }

  if (typeof target === 'string') {
    return looksLikeDirectoryTarget(target) ? join(target, defaultTraceFileName(trace)) : target;
  }

  if (target.filePath !== undefined) {
    return target.filePath;
  }

  return join(target.directory ?? process.cwd(), defaultTraceFileName(trace));
}

function toSerializableTrace<TSpan extends Span>(trace: Trace<TSpan>): Trace<TSpan> {
  return {
    id: trace.id,
    name: trace.name,
    version: trace.version,
    startTime: trace.startTime,
    endTime: trace.endTime,
    duration: trace.duration,
    spans: trace.spans,
    metadata: trace.metadata
  };
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableJsonValue(value: unknown): SerializedJsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : serialize(value);
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      return serialize(value);
    case 'object':
      break;
  }

  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_item, index) => {
      if (Object.prototype.hasOwnProperty.call(value, index)) {
        return stableJsonValue(value[index]);
      }

      return serialize(undefined);
    });
  }

  if (!isPlainObject(value)) {
    return serialize(value);
  }

  const record = value as Readonly<Record<string, unknown>>;
  const stableRecord: Record<string, SerializedJsonValue> = {};

  for (const key of Object.keys(record).sort()) {
    stableRecord[key] = stableJsonValue(record[key]);
  }

  return stableRecord;
}

function stringifyTrace(trace: Trace): string {
  return JSON.stringify(stableJsonValue(toSerializableTrace(trace)));
}

/** Sanitizes a trace name into a cross-platform-safe filename segment. */
export function sanitizeTraceNameForFilename(name: string): string {
  const sanitized = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(COMBINING_MARK, '')
    .replace(SAFE_FILENAME_SEGMENT, '-')
    .replace(REPEATED_DASH, '-')
    .replace(EDGE_SEPARATORS, '')
    .slice(0, MAX_SAFE_NAME_LENGTH)
    .replace(EDGE_SEPARATORS, '');

  return sanitized.length === 0 ? 'trace' : sanitized;
}

/** Returns the default timestamped filename for a trace. */
export function defaultTraceFileName(trace: Trace): string {
  return `${sanitizeTraceNameForFilename(redactValue(trace.name))}.${traceTimestamp(trace)}${TRACE_FILE_SUFFIX}`;
}

/** Saves a trace as deterministic compact JSON and returns the path written. */
export async function saveTrace(trace: Trace, target?: TraceSaveTarget): Promise<string> {
  const redactedTrace = redactTrace(trace);
  const filePath = resolveSavePath(redactedTrace, target);

  try {
    await fsPromises.mkdir(dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, stringifyTrace(redactedTrace), 'utf8');
  } catch (error) {
    throw new ExportError(`Failed to save trace to ${filePath}: ${errorMessage(error)}`, {
      traceId: trace.id,
      context: { filePath },
      cause: error
    });
  }

  return filePath;
}

/** Attaches a non-enumerable save() method to a trace returned by the recorder. */
export function attachTraceSave<TSpan extends Span>(trace: Trace<TSpan>): RecordedTrace<TSpan> {
  Object.defineProperty(trace, 'save', {
    value: (target?: TraceSaveTarget): Promise<string> => saveTrace(trace, target),
    enumerable: false,
    configurable: false,
    writable: false
  });

  return trace as RecordedTrace<TSpan>;
}
