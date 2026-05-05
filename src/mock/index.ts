import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanError, type Trace } from '../core/types.js';

/** Output format for generated mock code. */
export type MockGenerationFormat = 'function' | 'vitest-mock' | 'jest-mock';

/** Behavior used after all recorded mock entries have been consumed. */
export type MockExhaustionBehavior = 'throw' | 'undefined';

/** Filters selecting which recorded spans produce mocks. */
export interface MockGenerationFilter {
  /** Span type to include. */
  readonly type?: SpanType | string;
  /** Span name to include, matched exactly for strings or via RegExp. */
  readonly name?: string | RegExp;
}

/** Options controlling TypeScript mock generation from a trace. */
export interface GenerateMocksOptions {
  /** Mock output format. Defaults to plain function mocks. */
  readonly format?: MockGenerationFormat;
  /** Optional filter limiting which spans produce mocks. */
  readonly filter?: MockGenerationFilter;
  /** Whether spans with recorded errors should be included. Defaults to true. */
  readonly includeErrors?: boolean;
  /** Behavior when a generated mock is called more times than recorded. Defaults to throw. */
  readonly onExhaustion?: MockExhaustionBehavior;
}

interface MockGroup {
  readonly type: SpanType;
  readonly name: string;
  readonly exportName: string;
  readonly spans: readonly Span[];
}

interface MockEntry {
  readonly span: Span;
  readonly isAsync: boolean;
  readonly output: unknown;
  readonly error: SpanError | null;
}

interface MockSelectionOptions {
  readonly includeErrors: boolean;
  readonly filter: MockGenerationFilter | undefined;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFormat(format: MockGenerationFormat | undefined): MockGenerationFormat {
  if (format === undefined) {
    return 'function';
  }
  if (format === 'function' || format === 'vitest-mock' || format === 'jest-mock') {
    return format;
  }

  throw new Error(`Unsupported mock generation format "${String(format)}". Expected function, vitest-mock, or jest-mock.`);
}

function normalizeExhaustion(behavior: MockExhaustionBehavior | undefined): MockExhaustionBehavior {
  if (behavior === undefined) {
    return 'throw';
  }
  if (behavior === 'throw' || behavior === 'undefined') {
    return behavior;
  }

  throw new Error(`Unsupported mock exhaustion behavior "${String(behavior)}". Expected throw or undefined.`);
}

function matchesName(spanName: string, filterName: string | RegExp | undefined): boolean {
  if (filterName === undefined) {
    return true;
  }
  if (typeof filterName === 'string') {
    return spanName === filterName;
  }

  filterName.lastIndex = 0;
  return filterName.test(spanName);
}

function matchesFilter(span: Span, options: MockSelectionOptions): boolean {
  if (span.error !== null && !options.includeErrors) {
    return false;
  }
  if (options.filter?.type !== undefined && span.type !== options.filter.type) {
    return false;
  }

  return matchesName(span.name, options.filter?.name);
}

function identifierFromName(name: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9_$]+/gu, '_')
    .replace(/^[^A-Za-z_$]+/u, '')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  const candidate = sanitized.length === 0 ? 'mock' : sanitized;

  return RESERVED_IDENTIFIERS.has(candidate) ? `${candidate}Mock` : candidate;
}

function withUniqueExportNames(groups: readonly Omit<MockGroup, 'exportName'>[]): readonly MockGroup[] {
  const usedNames = new Set<string>();

  return groups.map((group) => {
    const baseName = identifierFromName(group.name);
    const preferredName = usedNames.has(baseName) ? identifierFromName(`${group.type}_${baseName}`) : baseName;
    let exportName = preferredName;
    let suffix = 2;

    while (usedNames.has(exportName)) {
      exportName = `${preferredName}_${suffix}`;
      suffix += 1;
    }

    usedNames.add(exportName);
    return { ...group, exportName };
  });
}

function groupSpans(trace: Trace, options: MockSelectionOptions): readonly MockGroup[] {
  const grouped = new Map<string, { type: SpanType; name: string; spans: Span[] }>();

  for (const span of trace.spans) {
    if (!matchesFilter(span, options)) {
      continue;
    }

    const key = `${span.type}\u0000${span.name}`;
    const existing = grouped.get(key);

    if (existing === undefined) {
      grouped.set(key, {
        type: span.type,
        name: span.name,
        spans: [span]
      });
    } else {
      existing.spans.push(span);
    }
  }

  return withUniqueExportNames(Array.from(grouped.values()).filter((group) => group.spans.length > 0));
}

function stringLiteral(value: string): string {
  return JSON.stringify(value) ?? '""';
}

function jsonLiteral(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'undefined';
  } catch {
    return JSON.stringify(serialize(value), null, 2) ?? 'undefined';
  }
}

function outputType(span: Span): string | undefined {
  return isRecord(span.output) && typeof span.output.type === 'string' ? span.output.type : undefined;
}

function isAsyncSpan(span: Span): boolean {
  if (span.metadata.isAsync === true) {
    return true;
  }
  if (span.type === SpanType.Http) {
    return true;
  }
  if ((span.type === SpanType.Db || span.type === SpanType.Queue) && (outputType(span) === 'resolve' || outputType(span) === 'reject')) {
    return true;
  }
  if (span.type === SpanType.Fs && span.metadata.api === 'promises') {
    return true;
  }

  return false;
}

function outputRecordValue(output: Readonly<Record<string, unknown>>, key: string): unknown {
  return output[key];
}

function outputValue(span: Span): unknown {
  if (!isRecord(span.output)) {
    return span.output;
  }

  if (span.type === SpanType.Env && 'value' in span.output) {
    return outputRecordValue(span.output, 'value');
  }

  if (span.type === SpanType.Timer) {
    if ('result' in span.output) {
      return outputRecordValue(span.output, 'result');
    }
    if ('value' in span.output) {
      return outputRecordValue(span.output, 'value');
    }
  }

  if (span.type === SpanType.Fs) {
    if ('result' in span.output) {
      return outputRecordValue(span.output, 'result');
    }
    if (span.output.success === true) {
      return undefined;
    }
  }

  if ((span.type === SpanType.Db || span.type === SpanType.Queue) && 'result' in span.output) {
    return outputRecordValue(span.output, 'result');
  }

  return span.output;
}

function entryFromSpan(span: Span): MockEntry {
  return {
    span,
    isAsync: isAsyncSpan(span),
    output: outputValue(span),
    error: span.error
  };
}

function entriesForGroup(group: MockGroup): readonly MockEntry[] {
  return group.spans.map(entryFromSpan);
}

function allEntriesAsync(entries: readonly MockEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => entry.isAsync);
}

function generatedHeader(format: MockGenerationFormat): string {
  const lines = [
    '/* Generated by GhostTrace mock generation. */',
    '/* eslint-disable */'
  ];

  if (format === 'vitest-mock') {
    lines.push("import { vi } from 'vitest';");
  }

  return lines.join('\n');
}

const RUNTIME_HELPERS = `
type __GhostTraceMockEntry = {
  async: boolean;
  value?: unknown;
  error?: __GhostTraceSerializedError;
};

type __GhostTraceSerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: unknown;
  cause?: __GhostTraceSerializedError;
};

type __GhostTraceMockBuilder = {
  mockReturnValueOnce: (value: unknown) => __GhostTraceMockBuilder;
  mockResolvedValueOnce: (value: unknown) => __GhostTraceMockBuilder;
  mockImplementationOnce: (implementation: (...args: readonly unknown[]) => unknown) => __GhostTraceMockBuilder;
  mockRejectedValueOnce: (value: unknown) => __GhostTraceMockBuilder;
  mockImplementation: (implementation: (...args: readonly unknown[]) => unknown) => __GhostTraceMockBuilder;
};

function __ghosttraceIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function __ghosttraceString(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function __ghosttraceNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function __ghosttraceErrorRecord(value: unknown): __GhostTraceSerializedError {
  if (!__ghosttraceIsRecord(value)) {
    return { name: 'Error', message: __ghosttraceString(value) };
  }

  const record: __GhostTraceSerializedError = {
    name: typeof value.name === 'string' ? value.name : 'Error',
    message: typeof value.message === 'string' ? value.message : ''
  };
  if (typeof value.stack === 'string') {
    record.stack = value.stack;
  }
  if ('code' in value) {
    record.code = value.code;
  }
  if (__ghosttraceIsRecord(value.cause)) {
    record.cause = __ghosttraceErrorRecord(value.cause);
  }
  return record;
}

function __ghosttraceCreateError(record: __GhostTraceSerializedError): Error {
  let error: Error;
  switch (record.name) {
    case 'EvalError':
      error = new EvalError(record.message);
      break;
    case 'RangeError':
      error = new RangeError(record.message);
      break;
    case 'ReferenceError':
      error = new ReferenceError(record.message);
      break;
    case 'SyntaxError':
      error = new SyntaxError(record.message);
      break;
    case 'TypeError':
      error = new TypeError(record.message);
      break;
    case 'URIError':
      error = new URIError(record.message);
      break;
    default:
      error = new Error(record.message);
      error.name = record.name;
      break;
  }

  if (record.stack !== undefined) {
    error.stack = record.stack;
  }

  const mutableError = error as Error & { code?: unknown; cause?: unknown };
  if (record.code !== undefined) {
    mutableError.code = record.code;
  }
  if (record.cause !== undefined) {
    mutableError.cause = __ghosttraceCreateError(record.cause);
  }

  return error;
}

function __ghosttraceBase64ToBytes(value: string): Uint8Array {
  const globalWithBuffer = globalThis as typeof globalThis & {
    readonly Buffer?: { readonly from: (input: string, encoding: 'base64') => Uint8Array };
  };
  if (globalWithBuffer.Buffer !== undefined) {
    return globalWithBuffer.Buffer.from(value, 'base64');
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function __ghosttraceCloneMarker(value: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = __ghosttraceDeserialize(entry);
  }
  return cloned;
}

function __ghosttraceDeserialize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => __ghosttraceDeserialize(entry));
  }
  if (!__ghosttraceIsRecord(value)) {
    return value;
  }
  if (value.__ghosttrace_tag === true && typeof value.__type === 'string') {
    switch (value.__type) {
      case 'Undefined':
        return undefined;
      case 'BigInt':
        return BigInt(__ghosttraceString(value.value));
      case 'Number': {
        const numberValue = __ghosttraceString(value.value);
        if (numberValue === 'NaN') {
          return Number.NaN;
        }
        if (numberValue === 'Infinity') {
          return Number.POSITIVE_INFINITY;
        }
        if (numberValue === '-Infinity') {
          return Number.NEGATIVE_INFINITY;
        }
        if (numberValue === '-0') {
          return -0;
        }
        return Number(numberValue);
      }
      case 'Date':
        return new Date(__ghosttraceString(value.value));
      case 'Buffer': {
        const globalWithBuffer = globalThis as typeof globalThis & {
          readonly Buffer?: { readonly from: (input: string, encoding: 'base64') => unknown };
        };
        return globalWithBuffer.Buffer?.from(__ghosttraceString(value.value), 'base64') ?? __ghosttraceBase64ToBytes(__ghosttraceString(value.value));
      }
      case 'Uint8Array':
        return __ghosttraceBase64ToBytes(__ghosttraceString(value.value));
      case 'RegExp': {
        const regexp = new RegExp(__ghosttraceString(value.source), __ghosttraceString(value.flags));
        regexp.lastIndex = __ghosttraceNumber(value.lastIndex, 0);
        return regexp;
      }
      case 'Error':
        return __ghosttraceCreateError(__ghosttraceErrorRecord(value));
      case 'Map': {
        const entries = Array.isArray(value.entries) ? value.entries : [];
        return new Map(entries.map((entry) => {
          if (!Array.isArray(entry)) {
            return [undefined, undefined] as const;
          }
          return [__ghosttraceDeserialize(entry[0]), __ghosttraceDeserialize(entry[1])] as const;
        }));
      }
      case 'Set': {
        const values = Array.isArray(value.values) ? value.values : [];
        return new Set(values.map((entry) => __ghosttraceDeserialize(entry)));
      }
      case 'Function':
        return function __ghosttraceFunctionPlaceholder(): never {
          throw new Error(\`GhostTrace function placeholder "\${__ghosttraceString(value.name)}" cannot be called\`);
        };
      case 'Array': {
        const length = __ghosttraceNumber(value.length, 0);
        const items = Array.isArray(value.items) ? value.items : [];
        const array = new Array<unknown>(length);
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (__ghosttraceIsRecord(item) && item.__ghosttrace_tag === true && item.__type === 'SparseHole') {
            continue;
          }
          array[index] = __ghosttraceDeserialize(item);
        }
        return array;
      }
      case 'CircularRef':
      case 'Truncated':
      case 'Unserializable':
      case 'SparseHole':
        return __ghosttraceCloneMarker(value);
      default:
        return __ghosttraceCloneMarker(value);
    }
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = __ghosttraceDeserialize(entry);
  }
  return output;
}

function __ghosttraceExhausted(name: string, count: number): Error {
  return new Error(\`GhostTrace mock "\${name}" exhausted after \${count} call(s)\`);
}

function __ghosttraceResolveEntry(name: string, entry: __GhostTraceMockEntry | undefined, count: number, asyncOnExhaustion: boolean, throwOnExhaustion: boolean): unknown {
  if (entry === undefined) {
    if (!throwOnExhaustion) {
      return asyncOnExhaustion ? Promise.resolve(undefined) : undefined;
    }

    const exhausted = __ghosttraceExhausted(name, count);
    if (asyncOnExhaustion) {
      return Promise.reject(exhausted);
    }
    throw exhausted;
  }
  if (entry.error !== undefined) {
    const error = __ghosttraceCreateError(entry.error);
    if (entry.async) {
      return Promise.reject(error);
    }
    throw error;
  }

  const value = __ghosttraceDeserialize(entry.value);
  return entry.async ? Promise.resolve(value) : value;
}
`.trim();

function frameworkRuntime(format: MockGenerationFormat): string {
  if (format === 'vitest-mock') {
    return 'const __ghosttraceMockFactory = { fn: (): __GhostTraceMockBuilder => vi.fn() as unknown as __GhostTraceMockBuilder };';
  }
  if (format === 'jest-mock') {
    return [
      'declare const jest: { readonly fn: () => __GhostTraceMockBuilder };',
      'const __ghosttraceMockFactory = { fn: (): __GhostTraceMockBuilder => jest.fn() };'
    ].join('\n');
  }

  return '';
}

function entryLiteral(entry: MockEntry): string {
  const fields = [`async: ${entry.isAsync ? 'true' : 'false'}`];

  if (entry.error !== null) {
    fields.push(`error: ${jsonLiteral(entry.error)}`);
  } else {
    fields.push(`value: ${jsonLiteral(entry.output)}`);
  }

  return `{ ${fields.join(', ')} }`;
}

function functionGroupCode(group: MockGroup, exhaustion: MockExhaustionBehavior): string {
  const entries = entriesForGroup(group);
  const entriesName = `__ghosttrace_${group.exportName}_entries`;
  const indexName = `__ghosttrace_${group.exportName}_index`;
  const asyncOnExhaustion = allEntriesAsync(entries);

  return [
    `const ${entriesName}: readonly __GhostTraceMockEntry[] = [`,
    entries.map((entry) => `  ${entryLiteral(entry)}`).join(',\n'),
    '];',
    `let ${indexName} = 0;`,
    `export function ${group.exportName}(..._args: readonly unknown[]): unknown {`,
    `  const entry = ${entriesName}[${indexName}];`,
    `  ${indexName} += 1;`,
    `  return __ghosttraceResolveEntry(${stringLiteral(group.exportName)}, entry, ${entries.length}, ${asyncOnExhaustion ? 'true' : 'false'}, ${exhaustion === 'throw' ? 'true' : 'false'});`,
    '}'
  ].join('\n');
}

function frameworkStep(entry: MockEntry): string {
  if (entry.error !== null) {
    if (entry.isAsync) {
      return `.mockRejectedValueOnce(__ghosttraceCreateError(${jsonLiteral(entry.error)}))`;
    }

    return `.mockImplementationOnce(() => { throw __ghosttraceCreateError(${jsonLiteral(entry.error)}); })`;
  }

  if (entry.isAsync) {
    return `.mockResolvedValueOnce(__ghosttraceDeserialize(${jsonLiteral(entry.output)}))`;
  }

  return `.mockReturnValueOnce(__ghosttraceDeserialize(${jsonLiteral(entry.output)}))`;
}

function frameworkFallback(group: MockGroup, entries: readonly MockEntry[], exhaustion: MockExhaustionBehavior): string {
  const asyncOnExhaustion = allEntriesAsync(entries);

  if (exhaustion === 'undefined') {
    return asyncOnExhaustion
      ? '.mockImplementation(() => Promise.resolve(undefined))'
      : '.mockImplementation(() => undefined)';
  }

  const errorExpression = `__ghosttraceExhausted(${stringLiteral(group.exportName)}, ${entries.length})`;

  return asyncOnExhaustion
    ? `.mockImplementation(() => Promise.reject(${errorExpression}))`
    : `.mockImplementation(() => { throw ${errorExpression}; })`;
}

function frameworkGroupCode(group: MockGroup, exhaustion: MockExhaustionBehavior): string {
  const entries = entriesForGroup(group);
  const chain = [...entries.map(frameworkStep), frameworkFallback(group, entries, exhaustion)];

  return [
    `export const ${group.exportName} = __ghosttraceMockFactory.fn()`,
    chain.map((step) => `  ${step}`).join('\n'),
    ';'
  ].join('\n');
}

function renderGroups(groups: readonly MockGroup[], format: MockGenerationFormat, exhaustion: MockExhaustionBehavior): string {
  if (format === 'function') {
    return groups.map((group) => functionGroupCode(group, exhaustion)).join('\n\n');
  }

  return groups.map((group) => frameworkGroupCode(group, exhaustion)).join('\n\n');
}

/** Generates valid TypeScript mock functions from recorded trace spans. */
export function generateMocks(trace: Trace, options: GenerateMocksOptions = {}): string {
  const format = normalizeFormat(options.format);
  const exhaustion = normalizeExhaustion(options.onExhaustion);
  const groups = groupSpans(trace, {
    filter: options.filter,
    includeErrors: options.includeErrors ?? true
  });
  const sections = [
    generatedHeader(format),
    RUNTIME_HELPERS,
    frameworkRuntime(format),
    renderGroups(groups, format, exhaustion)
  ].filter((section) => section.length > 0);

  return `${sections.join('\n\n')}\n`;
}
