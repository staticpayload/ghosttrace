import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { getTraceContext, type TraceContext } from '../core/context.js';
import { ReplayMismatchError } from '../core/errors.js';
import { deserialize, serialize, type SerializedJsonValue } from '../core/serializer.js';
import { SpanType, type Span, type SpanMetadata } from '../core/types.js';
import { isReplayStore, type ReplayStore } from '../replay/store.js';
import { isRecord, spanErrorFromUnknown } from './shared.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';

const FS_SENTINEL = '__GHOSTTRACE_FS_INTERCEPTOR_SENTINEL__';
const LARGE_FILE_THRESHOLD_BYTES = 256 * 1024;

type FsOperation = 'readFile' | 'writeFile' | 'readdir' | 'stat' | 'access' | 'mkdir' | 'unlink' | 'rename';
type FsApi = 'callback' | 'sync' | 'promises';
type FsFunction = (this: unknown, ...args: unknown[]) => unknown;
type FsCallback = (this: unknown, ...args: unknown[]) => void;

interface MutableNodeModule {
  [key: string]: unknown;
}

interface MutableFsModule extends MutableNodeModule {
  promises?: MutableNodeModule;
}

interface FsOperationEntry {
  readonly operation: FsOperation;
  readonly callbackName: string;
  readonly syncName: string;
  readonly promiseName: string;
}

interface ActiveFsSession {
  readonly addSpan: (span: Span) => void;
}

interface ActiveFsContext {
  readonly context: TraceContext;
  readonly session: ActiveFsSession;
  readonly replayStore?: ReplayStore;
}

interface ContentRefRecord {
  readonly algorithm: 'sha256';
  readonly hash: string;
  readonly byteLength: number;
}

interface CapturedContent {
  readonly kind: string;
  readonly byteLength: number;
  readonly encoding?: string;
  readonly content?: string;
  readonly contentBase64?: string;
  readonly contentRef?: ContentRefRecord;
}

interface StatTypeFlags {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly isBlockDevice: boolean;
  readonly isCharacterDevice: boolean;
  readonly isFIFO: boolean;
  readonly isSocket: boolean;
}

interface SerializedStats {
  readonly fields: Readonly<Record<string, number | string>>;
  readonly times: Readonly<Record<string, string>>;
  readonly type: StatTypeFlags;
}

interface SerializedDirent {
  readonly name: string;
  readonly type: StatTypeFlags;
  readonly parentPath?: string;
  readonly path?: string;
}

const requireNodeModule = createRequire(import.meta.url);
const nodeFs = requireNodeModule('node:fs') as MutableFsModule;
const nodeFsPromises = requireNodeModule('node:fs/promises') as MutableNodeModule;

const operations: readonly FsOperationEntry[] = [
  { operation: 'readFile', callbackName: 'readFile', syncName: 'readFileSync', promiseName: 'readFile' },
  { operation: 'writeFile', callbackName: 'writeFile', syncName: 'writeFileSync', promiseName: 'writeFile' },
  { operation: 'readdir', callbackName: 'readdir', syncName: 'readdirSync', promiseName: 'readdir' },
  { operation: 'stat', callbackName: 'stat', syncName: 'statSync', promiseName: 'stat' },
  { operation: 'access', callbackName: 'access', syncName: 'accessSync', promiseName: 'access' },
  { operation: 'mkdir', callbackName: 'mkdir', syncName: 'mkdirSync', promiseName: 'mkdir' },
  { operation: 'unlink', callbackName: 'unlink', syncName: 'unlinkSync', promiseName: 'unlink' },
  { operation: 'rename', callbackName: 'rename', syncName: 'renameSync', promiseName: 'rename' }
] as const;

const statFieldNames = [
  'dev',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'blksize',
  'ino',
  'size',
  'blocks',
  'atimeMs',
  'mtimeMs',
  'ctimeMs',
  'birthtimeMs'
] as const;
const statTimeNames = ['atime', 'mtime', 'ctime', 'birthtime'] as const;

const activeFsSessions = new Map<string, ActiveFsSession>();
const originalFsFunctions = new Map<string, FsFunction>();
const patchedFsFunctions = new Map<string, FsFunction>();
const originalFsPromisesFunctions = new Map<string, FsFunction>();
const patchedFsPromisesFunctions = new Map<string, FsFunction>();
const replayLargeContent = new Map<string, string | Buffer>();

function markFsInterceptorBundled(): string {
  return FS_SENTINEL;
}

function functionFromModule(module: MutableNodeModule | undefined, key: string): FsFunction | undefined {
  const value = module?.[key];
  return typeof value === 'function' ? (value as FsFunction) : undefined;
}

function setModuleFunction(module: MutableNodeModule | undefined, key: string, value: FsFunction): void {
  if (module !== undefined) {
    module[key] = value;
  }
}

function activeFsContext(): ActiveFsContext | undefined {
  const context = getTraceContext();

  if (context === undefined) {
    return undefined;
  }

  const session = activeFsSessions.get(context.traceId);
  if (session === undefined) {
    return undefined;
  }

  if (context.mode === 'replay') {
    const replayStore = isReplayStore(context.replayStore) ? context.replayStore : undefined;
    if (replayStore === undefined || !replayStore.canReplay(SpanType.Fs)) {
      return undefined;
    }

    return { context, session, replayStore };
  }

  return { context, session };
}

function pathString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  if (value instanceof URL) {
    return fileURLToPath(value);
  }

  return String(value);
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function optionalArgument(args: readonly unknown[], index: number): unknown {
  const value = args[index];
  return isFunction(value) ? undefined : value;
}

function normalizeOptions(value: unknown): unknown {
  if (value === undefined || isFunction(value)) {
    return undefined;
  }
  if (typeof value === 'string') {
    return { encoding: value };
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (isRecord(value)) {
    return { ...value };
  }

  return String(value);
}

function bufferEncodingFromValue(value: unknown): BufferEncoding | undefined {
  if (typeof value === 'string' && Buffer.isEncoding(value)) {
    return value;
  }
  if (isRecord(value)) {
    const encoding = value.encoding;
    if (typeof encoding === 'string' && Buffer.isEncoding(encoding)) {
      return encoding;
    }
  }

  return undefined;
}

function readEncoding(args: readonly unknown[]): BufferEncoding | undefined {
  return bufferEncodingFromValue(optionalArgument(args, 1));
}

function writeEncoding(args: readonly unknown[]): BufferEncoding | undefined {
  return bufferEncodingFromValue(optionalArgument(args, 2));
}

function cloneReplayContent(value: unknown): string | Buffer {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  return String(value);
}

function contentBuffer(value: unknown, encoding: BufferEncoding | undefined): Buffer {
  if (typeof value === 'string') {
    return Buffer.from(value, encoding ?? 'utf8');
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  return Buffer.from(String(value), 'utf8');
}

function contentKind(value: unknown): string {
  if (typeof value === 'string') {
    return 'string';
  }
  if (Buffer.isBuffer(value)) {
    return 'buffer';
  }
  if (value instanceof ArrayBuffer) {
    return 'ArrayBuffer';
  }
  if (ArrayBuffer.isView(value)) {
    return value.constructor.name;
  }

  return typeof value;
}

function contentStoreKey(traceId: string, hash: string): string {
  return `${traceId}:${hash}`;
}

function contentRef(buffer: Buffer): ContentRefRecord {
  return {
    algorithm: 'sha256',
    hash: createHash('sha256').update(buffer).digest('hex'),
    byteLength: buffer.byteLength
  };
}

function captureContent(value: unknown, encoding: BufferEncoding | undefined, traceId: string): CapturedContent {
  const buffer = contentBuffer(value, encoding);
  const kind = contentKind(value);
  const base = {
    kind,
    byteLength: buffer.byteLength,
    ...(encoding === undefined ? {} : { encoding })
  };

  if (buffer.byteLength > LARGE_FILE_THRESHOLD_BYTES) {
    const ref = contentRef(buffer);
    replayLargeContent.set(contentStoreKey(traceId, ref.hash), cloneReplayContent(value));
    return {
      ...base,
      contentRef: ref
    };
  }

  if (typeof value === 'string') {
    return {
      ...base,
      content: value
    };
  }

  return {
    ...base,
    contentBase64: buffer.toString('base64')
  };
}

function fsInput(operation: FsOperation, api: FsApi, args: readonly unknown[], traceId: string): Record<string, unknown> {
  const input: Record<string, unknown> = {
    operation,
    api
  };

  if (operation === 'rename') {
    input.oldPath = pathString(args[0]);
    input.newPath = pathString(args[1]);
    return input;
  }

  input.path = pathString(args[0]);

  if (operation === 'writeFile') {
    input.data = captureContent(args[1], writeEncoding(args), traceId);
    const options = normalizeOptions(optionalArgument(args, 2));
    if (options !== undefined) {
      input.options = options;
    }
    return input;
  }

  if (operation === 'access') {
    const mode = optionalArgument(args, 1);
    if (typeof mode === 'number') {
      input.mode = mode;
    }
    return input;
  }

  if (operation === 'readFile' || operation === 'readdir' || operation === 'stat' || operation === 'mkdir') {
    const options = normalizeOptions(optionalArgument(args, 1));
    if (options !== undefined) {
      input.options = options;
    }
  }

  return input;
}

function flagsFromMethods(value: unknown): StatTypeFlags {
  const record = value as Readonly<Record<string, unknown>>;

  return {
    isFile: typeof record.isFile === 'function' && Boolean(Reflect.apply(record.isFile, value, [])),
    isDirectory: typeof record.isDirectory === 'function' && Boolean(Reflect.apply(record.isDirectory, value, [])),
    isSymbolicLink:
      typeof record.isSymbolicLink === 'function' && Boolean(Reflect.apply(record.isSymbolicLink, value, [])),
    isBlockDevice: typeof record.isBlockDevice === 'function' && Boolean(Reflect.apply(record.isBlockDevice, value, [])),
    isCharacterDevice:
      typeof record.isCharacterDevice === 'function' && Boolean(Reflect.apply(record.isCharacterDevice, value, [])),
    isFIFO: typeof record.isFIFO === 'function' && Boolean(Reflect.apply(record.isFIFO, value, [])),
    isSocket: typeof record.isSocket === 'function' && Boolean(Reflect.apply(record.isSocket, value, []))
  };
}

function serializeStatValue(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }

  return undefined;
}

function serializeStats(value: unknown): SerializedStats {
  const record = value as Readonly<Record<string, unknown>>;
  const fields: Record<string, number | string> = {};
  const times: Record<string, string> = {};

  for (const field of statFieldNames) {
    const fieldValue = serializeStatValue(record[field]);
    if (fieldValue !== undefined) {
      fields[field] = fieldValue;
    }
  }

  for (const timeName of statTimeNames) {
    const timeValue = record[timeName];
    if (timeValue instanceof Date) {
      times[timeName] = timeValue.toISOString();
    }
  }

  return {
    fields,
    times,
    type: flagsFromMethods(value)
  };
}

function serializeDirent(value: unknown): unknown {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return captureContent(value, undefined, 'dirent');
  }
  if (!isRecord(value) || typeof value.name !== 'string') {
    return value;
  }

  const dirent: SerializedDirent = {
    name: value.name,
    type: flagsFromMethods(value),
    ...(typeof value.parentPath === 'string' ? { parentPath: value.parentPath } : {}),
    ...(typeof value.path === 'string' ? { path: value.path } : {})
  };

  return dirent;
}

function fsOutput(operation: FsOperation, result: unknown, args: readonly unknown[], traceId: string): Record<string, unknown> {
  if (operation === 'readFile') {
    return {
      result: captureContent(result, readEncoding(args), traceId)
    };
  }
  if (operation === 'writeFile' || operation === 'access' || operation === 'unlink' || operation === 'rename') {
    return {
      success: true
    };
  }
  if (operation === 'readdir') {
    return {
      result: Array.isArray(result) ? result.map(serializeDirent) : result
    };
  }
  if (operation === 'stat') {
    return {
      result: serializeStats(result)
    };
  }
  if (operation === 'mkdir') {
    return result === undefined
      ? {
          success: true
        }
      : {
          result,
          success: true
        };
  }

  return {
    result
  };
}

function createFsSpan(
  context: TraceContext,
  name: string,
  startTime: number,
  input: unknown,
  output: unknown,
  error: unknown,
  metadata: SpanMetadata
): Span {
  const endTime = context.clock.now();

  return {
    id: context.idGenerator.next(),
    parentId: context.currentSpan?.id ?? null,
    type: SpanType.Fs,
    name,
    startTime,
    endTime,
    duration: endTime - startTime,
    input: serialize(input),
    output: serialize(output),
    children: [],
    error: error === null ? null : spanErrorFromUnknown(error),
    metadata
  };
}

function addFsSpan(
  active: ActiveFsContext,
  name: string,
  startTime: number,
  input: unknown,
  output: unknown,
  error: unknown,
  metadata: SpanMetadata
): void {
  active.session.addSpan(createFsSpan(active.context, name, startTime, input, output, error, metadata));
}

function fsMetadata(entry: FsOperationEntry, api: FsApi, args: readonly unknown[]): SpanMetadata {
  const base: Record<string, unknown> = {
    operation: entry.operation,
    api
  };

  if (entry.operation === 'rename') {
    base.oldPath = pathString(args[0]);
    base.newPath = pathString(args[1]);
  } else {
    base.path = pathString(args[0]);
  }

  return base;
}

function callOriginal(original: FsFunction, thisArg: unknown, args: readonly unknown[]): unknown {
  return Reflect.apply(original, thisArg, [...args]);
}

function recordSyncOperation(active: ActiveFsContext, entry: FsOperationEntry, args: readonly unknown[], original: FsFunction, thisArg: unknown): unknown {
  const name = `fs.${entry.syncName}`;
  const input = fsInput(entry.operation, 'sync', args, active.context.traceId);
  const metadata = fsMetadata(entry, 'sync', args);
  const startTime = active.context.clock.now();

  try {
    const result = callOriginal(original, thisArg, args);
    addFsSpan(active, name, startTime, input, fsOutput(entry.operation, result, args, active.context.traceId), null, metadata);
    return result;
  } catch (error) {
    addFsSpan(active, name, startTime, input, undefined, error, metadata);
    throw error;
  }
}

function callbackIndex(args: readonly unknown[]): number {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (isFunction(args[index])) {
      return index;
    }
  }

  return -1;
}

function recordCallbackOperation(
  active: ActiveFsContext,
  entry: FsOperationEntry,
  args: readonly unknown[],
  original: FsFunction,
  thisArg: unknown
): unknown {
  const name = `fs.${entry.callbackName}`;
  const input = fsInput(entry.operation, 'callback', args, active.context.traceId);
  const metadata = fsMetadata(entry, 'callback', args);
  const startTime = active.context.clock.now();
  const index = callbackIndex(args);

  if (index < 0) {
    try {
      const result = callOriginal(original, thisArg, args);
      addFsSpan(active, name, startTime, input, fsOutput(entry.operation, result, args, active.context.traceId), null, metadata);
      return result;
    } catch (error) {
      addFsSpan(active, name, startTime, input, undefined, error, metadata);
      throw error;
    }
  }

  const callback = args[index] as FsCallback;
  const patchedArgs = [...args];
  patchedArgs[index] = function ghosttraceFsCallback(this: unknown, ...callbackArgs: unknown[]): void {
    const error = callbackArgs[0] ?? null;
    const result = callbackArgs[1];

    if (error === null) {
      addFsSpan(active, name, startTime, input, fsOutput(entry.operation, result, args, active.context.traceId), null, metadata);
    } else {
      addFsSpan(active, name, startTime, input, undefined, error, metadata);
    }

    Reflect.apply(callback, this, callbackArgs);
  };

  try {
    return callOriginal(original, thisArg, patchedArgs);
  } catch (error) {
    addFsSpan(active, name, startTime, input, undefined, error, metadata);
    throw error;
  }
}

function recordPromiseOperation(
  active: ActiveFsContext,
  entry: FsOperationEntry,
  args: readonly unknown[],
  original: FsFunction,
  thisArg: unknown
): Promise<unknown> {
  const name = `fs.promises.${entry.promiseName}`;
  const input = fsInput(entry.operation, 'promises', args, active.context.traceId);
  const metadata = fsMetadata(entry, 'promises', args);
  const startTime = active.context.clock.now();

  try {
    return Promise.resolve(callOriginal(original, thisArg, args)).then(
      (result) => {
        addFsSpan(active, name, startTime, input, fsOutput(entry.operation, result, args, active.context.traceId), null, metadata);
        return result;
      },
      (error: unknown) => {
        addFsSpan(active, name, startTime, input, undefined, error, metadata);
        throw error;
      }
    );
  } catch (error) {
    addFsSpan(active, name, startTime, input, undefined, error, metadata);
    return Promise.reject(error);
  }
}

function errorFromSpan(span: Span): Error | null {
  if (span.error === null) {
    return null;
  }

  const error = new Error(span.error.message) as Error & { code?: string };
  error.name = span.error.name;
  if (span.error.code !== undefined) {
    error.code = span.error.code;
  }

  return error;
}

function scheduleReplayCallback(callback: FsCallback, args: readonly unknown[]): void {
  const invoke = (): void => {
    Reflect.apply(callback, undefined, [...args]);
  };

  if (typeof setImmediate === 'function') {
    setImmediate(invoke);
    return;
  }

  if (typeof process !== 'undefined' && typeof process.nextTick === 'function') {
    process.nextTick(invoke);
    return;
  }

  queueMicrotask(invoke);
}

function deserializeSpanValue(value: unknown): unknown {
  return deserialize(value as SerializedJsonValue);
}

function contentFromRecord(value: unknown, span: Span, traceId: string): string | Buffer {
  if (!isRecord(value)) {
    throw new ReplayMismatchError(`Recorded FS span ${span.name} is missing file content`, {
      traceId,
      spanId: span.id,
      context: { output: span.output }
    });
  }

  if (isRecord(value.contentRef) && typeof value.contentRef.hash === 'string') {
    const stored = replayLargeContent.get(contentStoreKey(traceId, value.contentRef.hash));
    if (stored === undefined) {
      throw new ReplayMismatchError(`Large file content for recorded FS span ${span.name} is not available in the trace`, {
        traceId,
        spanId: span.id,
        context: { contentRef: value.contentRef }
      });
    }

    return typeof stored === 'string' ? stored : Buffer.from(stored);
  }

  if (typeof value.content === 'string') {
    return value.content;
  }
  if (typeof value.contentBase64 === 'string') {
    return Buffer.from(value.contentBase64, 'base64');
  }

  throw new ReplayMismatchError(`Recorded FS span ${span.name} has unsupported file content`, {
    traceId,
    spanId: span.id,
    context: { output: span.output }
  });
}

function booleanFlags(value: unknown): StatTypeFlags {
  const record = isRecord(value) ? value : {};

  return {
    isFile: record.isFile === true,
    isDirectory: record.isDirectory === true,
    isSymbolicLink: record.isSymbolicLink === true,
    isBlockDevice: record.isBlockDevice === true,
    isCharacterDevice: record.isCharacterDevice === true,
    isFIFO: record.isFIFO === true,
    isSocket: record.isSocket === true
  };
}

function replayDirent(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.type) || typeof value.name !== 'string') {
    if (isRecord(value) && typeof value.contentBase64 === 'string') {
      return Buffer.from(value.contentBase64, 'base64');
    }

    return value;
  }

  const flags = booleanFlags(value.type);
  return {
    name: value.name,
    parentPath: typeof value.parentPath === 'string' ? value.parentPath : undefined,
    path: typeof value.path === 'string' ? value.path : undefined,
    isFile: () => flags.isFile,
    isDirectory: () => flags.isDirectory,
    isSymbolicLink: () => flags.isSymbolicLink,
    isBlockDevice: () => flags.isBlockDevice,
    isCharacterDevice: () => flags.isCharacterDevice,
    isFIFO: () => flags.isFIFO,
    isSocket: () => flags.isSocket
  };
}

function dateFromRecord(record: Readonly<Record<string, unknown>>, key: string): Date | undefined {
  const value = record[key];
  return typeof value === 'string' ? new Date(value) : undefined;
}

function replayStats(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.fields) || !isRecord(value.type)) {
    return value;
  }

  const flags = booleanFlags(value.type);
  const times = isRecord(value.times) ? value.times : {};
  return {
    ...value.fields,
    atime: dateFromRecord(times, 'atime'),
    mtime: dateFromRecord(times, 'mtime'),
    ctime: dateFromRecord(times, 'ctime'),
    birthtime: dateFromRecord(times, 'birthtime'),
    isFile: () => flags.isFile,
    isDirectory: () => flags.isDirectory,
    isSymbolicLink: () => flags.isSymbolicLink,
    isBlockDevice: () => flags.isBlockDevice,
    isCharacterDevice: () => flags.isCharacterDevice,
    isFIFO: () => flags.isFIFO,
    isSocket: () => flags.isSocket
  };
}

function replayResult(active: ActiveFsContext, entry: FsOperationEntry, span: Span): unknown {
  if (span.error !== null) {
    throw errorFromSpan(span);
  }

  const output = span.output;
  const result = isRecord(output) ? output.result : undefined;

  if (entry.operation === 'readFile') {
    return contentFromRecord(result, span, active.context.traceId);
  }
  if (entry.operation === 'readdir') {
    const entries = Array.isArray(result) ? result : deserializeSpanValue(result);
    return Array.isArray(entries) ? entries.map(replayDirent) : entries;
  }
  if (entry.operation === 'stat') {
    return replayStats(result);
  }
  if (entry.operation === 'mkdir') {
    return result;
  }

  return undefined;
}

function consumeReplaySpan(
  active: ActiveFsContext,
  entry: FsOperationEntry,
  name: string,
  api: FsApi,
  args: readonly unknown[]
): Span | undefined {
  return active.replayStore?.consumeSpan(SpanType.Fs, name, fsInput(entry.operation, api, args, active.context.traceId))?.span;
}

function replaySyncOperation(active: ActiveFsContext, entry: FsOperationEntry, args: readonly unknown[], original: FsFunction, thisArg: unknown): unknown {
  const span = consumeReplaySpan(active, entry, `fs.${entry.syncName}`, 'sync', args);
  if (span === undefined) {
    return callOriginal(original, thisArg, args);
  }

  return replayResult(active, entry, span);
}

function replayCallbackOperation(
  active: ActiveFsContext,
  entry: FsOperationEntry,
  args: readonly unknown[],
  original: FsFunction,
  thisArg: unknown
): unknown {
  const index = callbackIndex(args);
  if (index < 0) {
    return replaySyncOperation(active, entry, args, original, thisArg);
  }

  const span = consumeReplaySpan(active, entry, `fs.${entry.callbackName}`, 'callback', args);
  if (span === undefined) {
    return callOriginal(original, thisArg, args);
  }

  const callback = args[index] as FsCallback;
  const error = errorFromSpan(span);
  if (error !== null) {
    scheduleReplayCallback(callback, [error]);
    return undefined;
  }

  const result = replayResult(active, entry, span);
  if (entry.operation === 'readFile' || entry.operation === 'readdir' || entry.operation === 'stat' || entry.operation === 'mkdir') {
    scheduleReplayCallback(callback, [null, result]);
    return undefined;
  }

  scheduleReplayCallback(callback, [null]);
  return undefined;
}

function replayPromiseOperation(
  active: ActiveFsContext,
  entry: FsOperationEntry,
  args: readonly unknown[],
  original: FsFunction,
  thisArg: unknown
): Promise<unknown> {
  const span = consumeReplaySpan(active, entry, `fs.promises.${entry.promiseName}`, 'promises', args);
  if (span === undefined) {
    return Promise.resolve(callOriginal(original, thisArg, args));
  }

  const error = errorFromSpan(span);
  if (error !== null) {
    return Promise.reject(error);
  }

  return Promise.resolve(replayResult(active, entry, span));
}

function createCallbackPatch(entry: FsOperationEntry, original: FsFunction): FsFunction {
  return function ghosttraceFsCallbackApi(this: unknown, ...args: unknown[]): unknown {
    const active = activeFsContext();
    if (active === undefined) {
      return callOriginal(original, this, args);
    }

    return active.context.mode === 'replay'
      ? replayCallbackOperation(active, entry, args, original, this)
      : recordCallbackOperation(active, entry, args, original, this);
  };
}

function createSyncPatch(entry: FsOperationEntry, original: FsFunction): FsFunction {
  return function ghosttraceFsSyncApi(this: unknown, ...args: unknown[]): unknown {
    const active = activeFsContext();
    if (active === undefined) {
      return callOriginal(original, this, args);
    }

    return active.context.mode === 'replay'
      ? replaySyncOperation(active, entry, args, original, this)
      : recordSyncOperation(active, entry, args, original, this);
  };
}

function createPromisePatch(entry: FsOperationEntry, original: FsFunction): FsFunction {
  return function ghosttraceFsPromiseApi(this: unknown, ...args: unknown[]): Promise<unknown> {
    const active = activeFsContext();
    if (active === undefined) {
      return Promise.resolve(callOriginal(original, this, args));
    }

    return active.context.mode === 'replay'
      ? replayPromiseOperation(active, entry, args, original, this)
      : recordPromiseOperation(active, entry, args, original, this);
  };
}

function installCallbackAndSyncPatch(entry: FsOperationEntry): void {
  if (!originalFsFunctions.has(entry.callbackName)) {
    const originalCallback = functionFromModule(nodeFs, entry.callbackName);
    if (originalCallback !== undefined) {
      const patched = createCallbackPatch(entry, originalCallback);
      originalFsFunctions.set(entry.callbackName, originalCallback);
      patchedFsFunctions.set(entry.callbackName, patched);
      setModuleFunction(nodeFs, entry.callbackName, patched);
    }
  }

  if (!originalFsFunctions.has(entry.syncName)) {
    const originalSync = functionFromModule(nodeFs, entry.syncName);
    if (originalSync !== undefined) {
      const patched = createSyncPatch(entry, originalSync);
      originalFsFunctions.set(entry.syncName, originalSync);
      patchedFsFunctions.set(entry.syncName, patched);
      setModuleFunction(nodeFs, entry.syncName, patched);
    }
  }
}

function installPromisePatch(entry: FsOperationEntry): void {
  if (originalFsPromisesFunctions.has(entry.promiseName)) {
    return;
  }

  const originalPromise = functionFromModule(nodeFsPromises, entry.promiseName) ?? functionFromModule(nodeFs.promises, entry.promiseName);
  if (originalPromise === undefined) {
    return;
  }

  const patched = createPromisePatch(entry, originalPromise);
  originalFsPromisesFunctions.set(entry.promiseName, originalPromise);
  patchedFsPromisesFunctions.set(entry.promiseName, patched);
  setModuleFunction(nodeFsPromises, entry.promiseName, patched);
  setModuleFunction(nodeFs.promises, entry.promiseName, patched);
}

function installFsPatches(): void {
  for (const entry of operations) {
    installCallbackAndSyncPatch(entry);
    installPromisePatch(entry);
  }

  syncBuiltinESMExports();
}

function restoreFsPatchesIfIdle(): void {
  if (activeFsSessions.size > 0) {
    return;
  }

  for (const [name, original] of originalFsFunctions.entries()) {
    if (functionFromModule(nodeFs, name) === patchedFsFunctions.get(name)) {
      setModuleFunction(nodeFs, name, original);
    }
  }

  for (const [name, original] of originalFsPromisesFunctions.entries()) {
    const patched = patchedFsPromisesFunctions.get(name);
    if (functionFromModule(nodeFsPromises, name) === patched) {
      setModuleFunction(nodeFsPromises, name, original);
    }
    if (functionFromModule(nodeFs.promises, name) === patched) {
      setModuleFunction(nodeFs.promises, name, original);
    }
  }

  originalFsFunctions.clear();
  patchedFsFunctions.clear();
  originalFsPromisesFunctions.clear();
  patchedFsPromisesFunctions.clear();
  syncBuiltinESMExports();
}

function fsAvailable(): boolean {
  return typeof process !== 'undefined' && process.versions.node !== undefined && typeof nodeFs.readFile === 'function';
}

/** Filesystem interceptor for core fs callback, sync, and promises APIs. */
export const fsInterceptor: Interceptor = {
  name: 'fs',
  install: (context: InterceptorContext): Teardown => {
    void markFsInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return () => undefined;
    }

    activeFsSessions.set(traceContext.traceId, {
      addSpan: context.addSpan
    });
    installFsPatches();

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }

      installed = false;
      activeFsSessions.delete(traceContext.traceId);
      restoreFsPatchesIfIdle();
    };
  },
  isAvailable: fsAvailable
};
