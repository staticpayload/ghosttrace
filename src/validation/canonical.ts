import { serialize, type SerializedJsonValue } from '../core/serializer.js';
import type { Span, Trace } from '../core/types.js';

interface CanonicalizeOptions {
  readonly omitTopLevelChecksum?: boolean;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shouldOmitKey(path: string, key: string, options: CanonicalizeOptions): boolean {
  return options.omitTopLevelChecksum === true && path === '$' && key === 'checksum';
}

function canonicalJsonValue(
  value: unknown,
  path: string,
  options: CanonicalizeOptions
): SerializedJsonValue {
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
        return canonicalJsonValue(value[index], `${path}[${index}]`, options);
      }

      return serialize(undefined);
    });
  }

  if (!isPlainObject(value)) {
    return serialize(value);
  }

  const record = value as Readonly<Record<string, unknown>>;
  const canonicalRecord: Record<string, SerializedJsonValue> = {};

  for (const key of Object.keys(record).sort()) {
    if (!shouldOmitKey(path, key, options)) {
      canonicalRecord[key] = canonicalJsonValue(record[key], `${path}.${key}`, options);
    }
  }

  return canonicalRecord;
}

/** Converts a value to canonical JSON with lexicographically sorted object keys. */
export function canonicalJsonStringify(value: unknown, options: CanonicalizeOptions = {}): string {
  return JSON.stringify(canonicalJsonValue(value, '$', options));
}

/** Returns a plain serializable trace object without non-enumerable helpers. */
export function toSerializableTrace<TSpan extends Span>(trace: Trace<TSpan>): Trace<TSpan> {
  const serializable: {
    id: string;
    name: string;
    version: string;
    startTime: number;
    endTime: number;
    duration: number;
    spans: readonly TSpan[];
    metadata: Trace<TSpan>['metadata'];
    checksum?: string;
  } = {
    id: trace.id,
    name: trace.name,
    version: trace.version,
    startTime: trace.startTime,
    endTime: trace.endTime,
    duration: trace.duration,
    spans: trace.spans,
    metadata: trace.metadata
  };

  if (trace.checksum !== undefined) {
    serializable.checksum = trace.checksum;
  }

  return serializable;
}
