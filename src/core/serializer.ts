import { Buffer } from 'node:buffer';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** JSON primitive values emitted by the GhostTrace serializer. */
export type SerializedJsonPrimitive = string | number | boolean | null;

/** JSON object values emitted by the GhostTrace serializer. */
export interface SerializedJsonObject {
  readonly [key: string]: SerializedJsonValue;
}

/** JSON-compatible value emitted by the GhostTrace serializer. */
export type SerializedJsonValue =
  | SerializedJsonPrimitive
  | readonly SerializedJsonValue[]
  | SerializedJsonObject;

/** Options controlling structured-clone-safe serialization. */
export interface SerializeOptions {
  /** Maximum nested object/array depth before values are replaced by truncation markers. */
  readonly maxDepth?: number;
}

/** Options for writing serialized JSON to disk. */
export interface WriteSerializedJsonOptions extends SerializeOptions {
  /** Maximum string chunk size emitted while streaming JSON. */
  readonly chunkSize?: number;
}

type MarkerType =
  | 'Undefined'
  | 'BigInt'
  | 'Number'
  | 'Date'
  | 'Buffer'
  | 'Uint8Array'
  | 'RegExp'
  | 'Error'
  | 'Map'
  | 'Set'
  | 'Function'
  | 'CircularRef'
  | 'Truncated'
  | 'Unserializable'
  | 'Array'
  | 'SparseHole';

interface SerializeContext {
  readonly maxDepth: number;
  readonly chunkSize: number;
  readonly ancestors: WeakMap<object, string>;
}

const TYPE_KEY = '__type';
const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const SIMPLE_PATH_SEGMENT = /^[A-Za-z_$][\w$]*$/u;
const ERROR_RESERVED_KEYS = new Set(['name', 'message', 'stack', 'cause', 'code']);

function createContext(options: WriteSerializedJsonOptions): SerializeContext {
  return {
    maxDepth: normalizeMaxDepth(options.maxDepth),
    chunkSize: normalizeChunkSize(options.chunkSize),
    ancestors: new WeakMap<object, string>()
  };
}

function normalizeMaxDepth(maxDepth: number | undefined): number {
  if (maxDepth === undefined) {
    return DEFAULT_MAX_DEPTH;
  }

  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError('serialize maxDepth must be a non-negative integer');
  }

  return maxDepth;
}

function normalizeChunkSize(chunkSize: number | undefined): number {
  if (chunkSize === undefined) {
    return DEFAULT_CHUNK_SIZE;
  }

  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError('writeSerializedJson chunkSize must be a positive integer');
  }

  return chunkSize;
}

function marker(type: MarkerType, properties: Record<string, SerializedJsonValue> = {}): SerializedJsonObject {
  return {
    [TYPE_KEY]: type,
    ...properties
  };
}

function appendObjectPath(path: string, key: string): string {
  if (SIMPLE_PATH_SEGMENT.test(key)) {
    return `${path}.${key}`;
  }

  return `${path}[${JSON.stringify(key)}]`;
}

function appendArrayPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

function serializeNumber(value: number): SerializedJsonValue {
  if (Number.isNaN(value)) {
    return marker('Number', { value: 'NaN' });
  }
  if (value === Number.POSITIVE_INFINITY) {
    return marker('Number', { value: 'Infinity' });
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return marker('Number', { value: '-Infinity' });
  }
  if (Object.is(value, -0)) {
    return marker('Number', { value: '-0' });
  }

  return value;
}

function serializeArray(value: readonly unknown[], context: SerializeContext, path: string, depth: number): SerializedJsonObject {
  const items: SerializedJsonValue[] = [];

  for (let index = 0; index < value.length; index += 1) {
    if (Object.prototype.hasOwnProperty.call(value, index)) {
      items.push(serializeValue(value[index], context, appendArrayPath(path, index), depth + 1));
    } else {
      items.push(marker('SparseHole'));
    }
  }

  return marker('Array', {
    length: value.length,
    items
  });
}

function serializeRegExp(value: RegExp): SerializedJsonObject {
  return marker('RegExp', {
    source: value.source,
    flags: value.flags,
    lastIndex: value.lastIndex
  });
}

function serializeError(value: Error, context: SerializeContext, path: string, depth: number): SerializedJsonObject {
  const errorRecord = value as Error & { readonly cause?: unknown; readonly code?: unknown };
  const serialized: Record<string, SerializedJsonValue> = {
    name: value.name,
    message: value.message
  };

  if (value.stack !== undefined) {
    serialized.stack = value.stack;
  }

  if (errorRecord.code !== undefined) {
    serialized.code = serializeValue(errorRecord.code, context, appendObjectPath(path, 'code'), depth + 1);
  }

  if (errorRecord.cause !== undefined) {
    serialized.cause = serializeValue(errorRecord.cause, context, appendObjectPath(path, 'cause'), depth + 1);
  }

  const customProperties: Record<string, SerializedJsonValue> = {};
  const record = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ERROR_RESERVED_KEYS.has(key)) {
      customProperties[key] = serializeValue(record[key], context, appendObjectPath(path, key), depth + 1);
    }
  }

  if (Object.keys(customProperties).length > 0) {
    serialized.properties = customProperties;
  }

  return marker('Error', serialized);
}

function serializeMap(value: Map<unknown, unknown>, context: SerializeContext, path: string, depth: number): SerializedJsonObject {
  const entries: SerializedJsonValue[] = [];
  let index = 0;

  for (const [entryKey, entryValue] of value) {
    entries.push([
      serializeValue(entryKey, context, `${path}.entries[${index}][0]`, depth + 1),
      serializeValue(entryValue, context, `${path}.entries[${index}][1]`, depth + 1)
    ]);
    index += 1;
  }

  return marker('Map', { entries });
}

function serializeSet(value: Set<unknown>, context: SerializeContext, path: string, depth: number): SerializedJsonObject {
  const values: SerializedJsonValue[] = [];
  let index = 0;

  for (const item of value) {
    values.push(serializeValue(item, context, `${path}.values[${index}]`, depth + 1));
    index += 1;
  }

  return marker('Set', { values });
}

function serializePlainObject(value: object, context: SerializeContext, path: string, depth: number): SerializedJsonObject {
  const serialized: Record<string, SerializedJsonValue> = {};
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    serialized[key] = serializeValue(record[key], context, appendObjectPath(path, key), depth + 1);
  }

  return serialized;
}

function serializeObject(value: object, context: SerializeContext, path: string, depth: number): SerializedJsonValue {
  if (depth >= context.maxDepth) {
    return marker('Truncated', {
      maxDepth: context.maxDepth,
      path
    });
  }

  const circularPath = context.ancestors.get(value);
  if (circularPath !== undefined) {
    return marker('CircularRef', { path: circularPath });
  }

  context.ancestors.set(value, path);
  try {
    if (value instanceof Date) {
      return marker('Date', { value: value.toISOString() });
    }

    if (Buffer.isBuffer(value)) {
      return marker('Buffer', {
        encoding: 'base64',
        value: value.toString('base64')
      });
    }

    if (value instanceof Uint8Array) {
      return marker('Uint8Array', {
        encoding: 'base64',
        value: Buffer.from(value).toString('base64')
      });
    }

    if (value instanceof RegExp) {
      return serializeRegExp(value);
    }

    if (value instanceof Error) {
      return serializeError(value, context, path, depth);
    }

    if (value instanceof Map) {
      return serializeMap(value, context, path, depth);
    }

    if (value instanceof Set) {
      return serializeSet(value, context, path, depth);
    }

    if (Array.isArray(value)) {
      return serializeArray(value, context, path, depth);
    }

    return serializePlainObject(value, context, path, depth);
  } finally {
    context.ancestors.delete(value);
  }
}

function serializeValue(value: unknown, context: SerializeContext, path: string, depth: number): SerializedJsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'undefined':
      return marker('Undefined');
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      return serializeNumber(value);
    case 'bigint':
      return marker('BigInt', { value: value.toString() });
    case 'function':
      return marker('Function', {
        name: value.name === '' ? '<anonymous>' : value.name
      });
    case 'symbol':
      return marker('Unserializable', {
        typeOf: 'symbol',
        toString: String(value)
      });
    case 'object':
      return serializeObject(value, context, path, depth);
  }

  return marker('Unserializable', {
    typeOf: typeof value,
    toString: String(value)
  });
}

function getStringProperty(value: SerializedJsonObject, key: string): string | undefined {
  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

function getNumberProperty(value: SerializedJsonObject, key: string): number | undefined {
  const property = value[key];
  return typeof property === 'number' ? property : undefined;
}

function isObjectValue(value: SerializedJsonValue): value is SerializedJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayValue(value: SerializedJsonValue): value is readonly SerializedJsonValue[] {
  return Array.isArray(value);
}

function isMarker(value: SerializedJsonValue, type: MarkerType): boolean {
  return isObjectValue(value) && value[TYPE_KEY] === type;
}

function deserializeNumber(value: SerializedJsonObject): number {
  switch (getStringProperty(value, 'value')) {
    case 'NaN':
      return Number.NaN;
    case 'Infinity':
      return Number.POSITIVE_INFINITY;
    case '-Infinity':
      return Number.NEGATIVE_INFINITY;
    case '-0':
      return -0;
    default:
      return Number.NaN;
  }
}

function deserializeRegExp(value: SerializedJsonObject): RegExp {
  const source = getStringProperty(value, 'source') ?? '';
  const flags = getStringProperty(value, 'flags') ?? '';
  const regexp = new RegExp(source, flags);
  const lastIndex = getNumberProperty(value, 'lastIndex');

  if (lastIndex !== undefined) {
    regexp.lastIndex = lastIndex;
  }

  return regexp;
}

function deserializeError(value: SerializedJsonObject): Error {
  const message = getStringProperty(value, 'message') ?? '';
  const causeValue = value.cause === undefined ? undefined : deserializeValue(value.cause);
  const error = causeValue === undefined ? new Error(message) : new Error(message, { cause: causeValue });
  const name = getStringProperty(value, 'name');
  const stack = getStringProperty(value, 'stack');
  const code = value.code === undefined ? undefined : deserializeValue(value.code);
  const mutableError = error as Error & Record<string, unknown>;

  if (name !== undefined) {
    error.name = name;
  }

  if (stack !== undefined) {
    Object.defineProperty(error, 'stack', {
      value: stack,
      writable: true,
      configurable: true
    });
  }

  if (code !== undefined) {
    mutableError.code = code;
  }

  const properties = value.properties;
  if (properties !== undefined && isObjectValue(properties)) {
    for (const key of Object.keys(properties)) {
      mutableError[key] = deserializeValue(properties[key] as SerializedJsonValue);
    }
  }

  return error;
}

function deserializeArray(value: SerializedJsonObject): unknown[] {
  const length = getNumberProperty(value, 'length') ?? 0;
  const items = value.items;
  const array = new Array<unknown>(length);

  if (!Array.isArray(items)) {
    return array;
  }

  for (let index = 0; index < Math.min(length, items.length); index += 1) {
    const item = items[index];
    if (item !== undefined && !isMarker(item, 'SparseHole')) {
      array[index] = deserializeValue(item);
    }
  }

  return array;
}

function deserializeMap(value: SerializedJsonObject): Map<unknown, unknown> {
  const entries = value.entries;
  const map = new Map<unknown, unknown>();

  if (!Array.isArray(entries)) {
    return map;
  }

  for (const entry of entries) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const key = entry[0];
      const entryValue = entry[1];
      if (key !== undefined && entryValue !== undefined) {
        map.set(deserializeValue(key), deserializeValue(entryValue));
      }
    }
  }

  return map;
}

function deserializeSet(value: SerializedJsonObject): Set<unknown> {
  const values = value.values;
  const set = new Set<unknown>();

  if (!Array.isArray(values)) {
    return set;
  }

  for (const item of values) {
    set.add(deserializeValue(item));
  }

  return set;
}

function deserializePlainObject(value: SerializedJsonObject): Record<string, unknown> {
  const deserialized: Record<string, unknown> = {};

  for (const key of Object.keys(value)) {
    deserialized[key] = deserializeValue(value[key] as SerializedJsonValue);
  }

  return deserialized;
}

function deserializeMarker(value: SerializedJsonObject, type: string): unknown {
  switch (type) {
    case 'Undefined':
      return undefined;
    case 'BigInt': {
      const serialized = getStringProperty(value, 'value') ?? '0';
      return BigInt(serialized);
    }
    case 'Number':
      return deserializeNumber(value);
    case 'Date': {
      const serialized = getStringProperty(value, 'value') ?? '';
      return new Date(serialized);
    }
    case 'Buffer': {
      const serialized = getStringProperty(value, 'value') ?? '';
      return Buffer.from(serialized, 'base64');
    }
    case 'Uint8Array': {
      const serialized = getStringProperty(value, 'value') ?? '';
      return new Uint8Array(Buffer.from(serialized, 'base64'));
    }
    case 'RegExp':
      return deserializeRegExp(value);
    case 'Error':
      return deserializeError(value);
    case 'Map':
      return deserializeMap(value);
    case 'Set':
      return deserializeSet(value);
    case 'Array':
      return deserializeArray(value);
    case 'Function':
    case 'CircularRef':
    case 'Truncated':
    case 'Unserializable':
    case 'SparseHole':
      return deserializePlainObject(value);
    default:
      return deserializePlainObject(value);
  }
}

function deserializeValue(value: SerializedJsonValue): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }

  if (isArrayValue(value)) {
    return value.map((item) => deserializeValue(item));
  }

  const type = getStringProperty(value, TYPE_KEY);
  if (type !== undefined) {
    return deserializeMarker(value, type);
  }

  return deserializePlainObject(value);
}

function* quoteStringChunks(value: string, chunkSize: number): Generator<string> {
  yield '"';

  let chunk = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    const code = char.charCodeAt(0);

    switch (char) {
      case '"':
        chunk += '\\"';
        break;
      case '\\':
        chunk += '\\\\';
        break;
      case '\b':
        chunk += '\\b';
        break;
      case '\f':
        chunk += '\\f';
        break;
      case '\n':
        chunk += '\\n';
        break;
      case '\r':
        chunk += '\\r';
        break;
      case '\t':
        chunk += '\\t';
        break;
      default:
        if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
          chunk += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          chunk += char;
        }
        break;
    }

    if (chunk.length >= chunkSize) {
      yield chunk;
      chunk = '';
    }
  }

  if (chunk.length > 0) {
    yield chunk;
  }

  yield '"';
}

function* jsonChunksForSerializedValue(value: SerializedJsonValue, chunkSize: number): Generator<string> {
  if (value === null) {
    yield 'null';
    return;
  }

  switch (typeof value) {
    case 'boolean':
      yield value ? 'true' : 'false';
      return;
    case 'number':
      yield Number.isFinite(value) ? String(value) : 'null';
      return;
    case 'string':
      yield* quoteStringChunks(value, chunkSize);
      return;
    case 'object':
      break;
  }

  if (isArrayValue(value)) {
    yield '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        yield ',';
      }
      yield* jsonChunksForSerializedValue(value[index] as SerializedJsonValue, chunkSize);
    }
    yield ']';
    return;
  }

  yield '{';
  let first = true;
  for (const key of Object.keys(value)) {
    if (!first) {
      yield ',';
    }
    first = false;
    yield* quoteStringChunks(key, chunkSize);
    yield ':';
    yield* jsonChunksForSerializedValue(value[key] as SerializedJsonValue, chunkSize);
  }
  yield '}';
}

function* jsonChunksForSerializedMarker(
  type: MarkerType,
  properties: Record<string, SerializedJsonValue>,
  chunkSize: number
): Generator<string> {
  yield* jsonChunksForSerializedValue(marker(type, properties), chunkSize);
}

function* jsonChunksForArray(value: readonly unknown[], context: SerializeContext, path: string, depth: number): Generator<string> {
  yield '{"__type":"Array","length":';
  yield String(value.length);
  yield ',"items":[';
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) {
      yield ',';
    }

    if (Object.prototype.hasOwnProperty.call(value, index)) {
      yield* jsonChunksForValue(value[index], context, appendArrayPath(path, index), depth + 1);
    } else {
      yield* jsonChunksForSerializedMarker('SparseHole', {}, context.chunkSize);
    }
  }
  yield ']}';
}

function* jsonChunksForMap(value: Map<unknown, unknown>, context: SerializeContext, path: string, depth: number): Generator<string> {
  yield '{"__type":"Map","entries":[';
  let index = 0;
  for (const [entryKey, entryValue] of value) {
    if (index > 0) {
      yield ',';
    }
    yield '[';
    yield* jsonChunksForValue(entryKey, context, `${path}.entries[${index}][0]`, depth + 1);
    yield ',';
    yield* jsonChunksForValue(entryValue, context, `${path}.entries[${index}][1]`, depth + 1);
    yield ']';
    index += 1;
  }
  yield ']}';
}

function* jsonChunksForSet(value: Set<unknown>, context: SerializeContext, path: string, depth: number): Generator<string> {
  yield '{"__type":"Set","values":[';
  let index = 0;
  for (const item of value) {
    if (index > 0) {
      yield ',';
    }
    yield* jsonChunksForValue(item, context, `${path}.values[${index}]`, depth + 1);
    index += 1;
  }
  yield ']}';
}

function* jsonChunksForPlainObject(value: object, context: SerializeContext, path: string, depth: number): Generator<string> {
  const record = value as Record<string, unknown>;
  yield '{';

  let first = true;
  for (const key of Object.keys(record)) {
    if (!first) {
      yield ',';
    }
    first = false;
    yield* quoteStringChunks(key, context.chunkSize);
    yield ':';
    yield* jsonChunksForValue(record[key], context, appendObjectPath(path, key), depth + 1);
  }

  yield '}';
}

function* jsonChunksForObject(value: object, context: SerializeContext, path: string, depth: number): Generator<string> {
  if (depth >= context.maxDepth) {
    yield* jsonChunksForSerializedMarker(
      'Truncated',
      {
        maxDepth: context.maxDepth,
        path
      },
      context.chunkSize
    );
    return;
  }

  const circularPath = context.ancestors.get(value);
  if (circularPath !== undefined) {
    yield* jsonChunksForSerializedMarker('CircularRef', { path: circularPath }, context.chunkSize);
    return;
  }

  context.ancestors.set(value, path);
  try {
    if (value instanceof Date) {
      yield* jsonChunksForSerializedMarker('Date', { value: value.toISOString() }, context.chunkSize);
      return;
    }

    if (Buffer.isBuffer(value)) {
      yield* jsonChunksForSerializedMarker(
        'Buffer',
        {
          encoding: 'base64',
          value: value.toString('base64')
        },
        context.chunkSize
      );
      return;
    }

    if (value instanceof Uint8Array) {
      yield* jsonChunksForSerializedMarker(
        'Uint8Array',
        {
          encoding: 'base64',
          value: Buffer.from(value).toString('base64')
        },
        context.chunkSize
      );
      return;
    }

    if (value instanceof RegExp) {
      yield* jsonChunksForSerializedValue(serializeRegExp(value), context.chunkSize);
      return;
    }

    if (value instanceof Error) {
      yield* jsonChunksForSerializedValue(serializeError(value, context, path, depth), context.chunkSize);
      return;
    }

    if (value instanceof Map) {
      yield* jsonChunksForMap(value, context, path, depth);
      return;
    }

    if (value instanceof Set) {
      yield* jsonChunksForSet(value, context, path, depth);
      return;
    }

    if (Array.isArray(value)) {
      yield* jsonChunksForArray(value, context, path, depth);
      return;
    }

    yield* jsonChunksForPlainObject(value, context, path, depth);
  } finally {
    context.ancestors.delete(value);
  }
}

function* jsonChunksForValue(value: unknown, context: SerializeContext, path: string, depth: number): Generator<string> {
  if (value === null) {
    yield 'null';
    return;
  }

  switch (typeof value) {
    case 'undefined':
      yield* jsonChunksForSerializedMarker('Undefined', {}, context.chunkSize);
      return;
    case 'boolean':
      yield value ? 'true' : 'false';
      return;
    case 'number':
      yield* jsonChunksForSerializedValue(serializeNumber(value), context.chunkSize);
      return;
    case 'string':
      yield* quoteStringChunks(value, context.chunkSize);
      return;
    case 'bigint':
      yield* jsonChunksForSerializedMarker('BigInt', { value: value.toString() }, context.chunkSize);
      return;
    case 'function':
      yield* jsonChunksForSerializedMarker(
        'Function',
        { name: value.name === '' ? '<anonymous>' : value.name },
        context.chunkSize
      );
      return;
    case 'symbol':
      yield* jsonChunksForSerializedMarker(
        'Unserializable',
        {
          typeOf: 'symbol',
          toString: String(value)
        },
        context.chunkSize
      );
      return;
    case 'object':
      yield* jsonChunksForObject(value, context, path, depth);
      return;
  }
}

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  if (stream.write(chunk)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      stream.off('drain', onDrain);
      stream.off('error', onError);
    }

    function onDrain(): void {
      cleanup();
      resolve();
    }

    function onError(error: Error): void {
      cleanup();
      reject(error);
    }

    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

function finishStream(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      stream.off('finish', onFinish);
      reject(error);
    }

    function onFinish(): void {
      stream.off('error', onError);
      resolve();
    }

    stream.once('error', onError);
    stream.once('finish', onFinish);
    stream.end();
  });
}

/** Serializes an arbitrary JavaScript value into a JSON-compatible GhostTrace value. */
export function serialize(value: unknown, options: SerializeOptions = {}): SerializedJsonValue {
  return serializeValue(value, createContext(options), '$', 0);
}

/** Deserializes a GhostTrace serialized JSON value back into supported JavaScript values. */
export function deserialize<TValue = unknown>(value: SerializedJsonValue): TValue {
  return deserializeValue(value) as TValue;
}

/** Streams the serialized JSON representation of a value as compact JSON chunks. */
export function* serializeToJsonChunks(value: unknown, options: WriteSerializedJsonOptions = {}): Generator<string> {
  yield* jsonChunksForValue(value, createContext(options), '$', 0);
}

/** Serializes and stringifies a value as compact JSON. */
export function stringifySerialized(value: unknown, options: SerializeOptions = {}): string {
  return [...serializeToJsonChunks(value, options)].join('');
}

/** Writes serialized JSON using a Node.js write stream so large traces avoid full-string writes. */
export async function writeSerializedJson(
  filePath: string,
  value: unknown,
  options: WriteSerializedJsonOptions = {}
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  const stream = createWriteStream(filePath, { encoding: 'utf8' });

  try {
    for (const chunk of serializeToJsonChunks(value, options)) {
      await writeChunk(stream, chunk);
    }
    await finishStream(stream);
  } catch (error) {
    stream.destroy();
    throw error;
  }
}
