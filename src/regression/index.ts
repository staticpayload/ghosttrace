import { SpanType, type Span, type Trace } from '../core/types.js';
import {
  generatedTrace,
  isRecord,
  jsonLiteral,
  serializedValue
} from '../generation/shared.js';

/** Test framework targeted by generated regression tests. */
export type TestGenerationFramework = 'vitest' | 'jest';

/** Assertion style used to compare replay output with recorded output. */
export type TestAssertionStyle = 'deep-equal' | 'snapshot' | 'schema';

/** Options controlling runnable regression test generation from a trace. */
export interface GenerateTestsOptions {
  /** Test framework import style. Defaults to Vitest. */
  readonly framework?: TestGenerationFramework;
  /** Replay output assertion style. Defaults to deep-equal. */
  readonly assertionStyle?: TestAssertionStyle;
  /** Module path imported by the generated test. Defaults to ./subject.js. */
  readonly modulePath?: string;
  /** Export name to invoke for every generated case. Defaults to the recorded function span name. */
  readonly functionName?: string;
  /** Whether to assert recorded HTTP/DB side-effect spans were replayed. Defaults to false. */
  readonly assertSideEffects?: boolean;
}

interface GeneratedTestCase {
  readonly spanId: string;
  readonly name: string;
  readonly functionName: string;
  readonly input: unknown;
  readonly output: unknown;
}

interface ExpectedSideEffect {
  readonly type: SpanType.Http | SpanType.Db;
  readonly name: string;
  readonly url?: string;
  readonly method?: string;
  readonly query?: string;
  readonly operation?: string;
}

function normalizeFramework(framework: TestGenerationFramework | undefined): TestGenerationFramework {
  if (framework === undefined) {
    return 'vitest';
  }
  if (framework === 'vitest' || framework === 'jest') {
    return framework;
  }

  throw new Error(`Unsupported test generation framework "${String(framework)}". Expected vitest or jest.`);
}

function normalizeAssertionStyle(style: TestAssertionStyle | undefined): TestAssertionStyle {
  if (style === undefined) {
    return 'deep-equal';
  }
  if (style === 'deep-equal' || style === 'snapshot' || style === 'schema') {
    return style;
  }

  throw new Error(`Unsupported test assertion style "${String(style)}". Expected deep-equal, snapshot, or schema.`);
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function functionSpans(trace: Trace): readonly Span[] {
  const roots = trace.spans.filter((span) => span.type === SpanType.Function && span.parentId === null);
  if (roots.length > 0) {
    return roots;
  }

  return trace.spans.filter((span) => span.type === SpanType.Function);
}

function testCases(trace: Trace, options: GenerateTestsOptions): readonly GeneratedTestCase[] {
  const selectedSpans = functionSpans(trace);
  if (selectedSpans.length === 0) {
    throw new Error('Cannot generate replay tests from a trace with no function spans.');
  }

  return selectedSpans.map((span) => ({
    spanId: span.id,
    name: span.name,
    functionName: options.functionName ?? span.name,
    input: serializedValue(span.input),
    output: serializedValue(span.output)
  }));
}

function sideEffectForSpan(span: Span): ExpectedSideEffect | undefined {
  if (span.type === SpanType.Http) {
    const inputUrl = readStringField(span.input, 'url');
    const metadataUrl = readStringField(span.metadata, 'url');
    const inputMethod = readStringField(span.input, 'method');
    const metadataMethod = readStringField(span.metadata, 'method');
    const url = inputUrl ?? metadataUrl;
    const method = inputMethod ?? metadataMethod;

    return {
      type: SpanType.Http,
      name: span.name,
      ...(url === undefined ? {} : { url }),
      ...(method === undefined ? {} : { method })
    };
  }

  if (span.type === SpanType.Db) {
    const inputQuery = readStringField(span.input, 'query');
    const metadataQuery = readStringField(span.metadata, 'query');
    const inputOperation = readStringField(span.input, 'operation');
    const metadataOperation = readStringField(span.metadata, 'operation');
    const query = inputQuery ?? metadataQuery;
    const operation = inputOperation ?? metadataOperation;

    return {
      type: SpanType.Db,
      name: span.name,
      ...(query === undefined ? {} : { query }),
      ...(operation === undefined ? {} : { operation })
    };
  }

  return undefined;
}

function expectedSideEffects(trace: Trace): readonly ExpectedSideEffect[] {
  return trace.spans.flatMap((span) => {
    const sideEffect = sideEffectForSpan(span);
    return sideEffect === undefined ? [] : [sideEffect];
  });
}

function frameworkImport(framework: TestGenerationFramework): string {
  if (framework === 'vitest') {
    return "import { describe, expect, it } from 'vitest';";
  }

  return "import { describe, expect, it } from '@jest/globals';";
}

function singleQuotedStringLiteral(value: string): string {
  return `'${value
    .replace(/\\/gu, '\\\\')
    .replace(/'/gu, "\\'")
    .replace(/\r/gu, '\\r')
    .replace(/\n/gu, '\\n')
    .replace(/\t/gu, '\\t')}'`;
}

const RUNTIME_HELPERS = `
type __GhostTraceTestCase = {
  readonly spanId: string;
  readonly name: string;
  readonly functionName: string;
  readonly input: unknown;
  readonly output: unknown;
};

type __GhostTraceExpectedSideEffect = {
  readonly type: string;
  readonly name: string;
  readonly url?: string;
  readonly method?: string;
  readonly query?: string;
  readonly operation?: string;
};

type __GhostTraceJsonSchema = {
  readonly type: 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string' | 'unknown';
  readonly items?: __GhostTraceJsonSchema;
  readonly properties?: Readonly<Record<string, __GhostTraceJsonSchema>>;
  readonly required?: readonly string[];
};

type __GhostTraceSerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: unknown;
  cause?: __GhostTraceSerializedError;
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
  const error = new Error(record.message);
  error.name = record.name;
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
      case 'Function':
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

function __ghosttraceGetCase(index: number): __GhostTraceTestCase {
  const testCase = __ghosttraceTestCases[index];
  if (testCase === undefined) {
    throw new Error(\`Missing GhostTrace generated test case at index \${index}\`);
  }
  return testCase;
}

function __ghosttraceInvokeTracedFunction(name: string, input: unknown): unknown {
  const moduleExports = __ghosttraceSubject as Readonly<Record<string, unknown>>;
  const tracedFunction = moduleExports[name];
  if (typeof tracedFunction !== 'function') {
    throw new Error(\`GhostTrace generated test expected export "\${name}" to be a function\`);
  }

  const args = Array.isArray(input) ? input : [input];
  return (tracedFunction as (...args: readonly unknown[]) => unknown)(...args);
}

function __ghosttraceJsonSchemaFromValue(value: unknown): __GhostTraceJsonSchema {
  if (value === null) {
    return { type: 'null' };
  }
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length === 0 ? { type: 'unknown' } : __ghosttraceJsonSchemaFromValue(value[0]) };
  }
  if (__ghosttraceIsRecord(value)) {
    const properties: Record<string, __GhostTraceJsonSchema> = {};
    for (const [key, entry] of Object.entries(value)) {
      properties[key] = __ghosttraceJsonSchemaFromValue(entry);
    }
    return { type: 'object', properties, required: Object.keys(properties) };
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean' };
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return { type: 'number' };
  }
  if (typeof value === 'string') {
    return { type: 'string' };
  }
  return { type: 'unknown' };
}

function __ghosttraceValidateJsonSchema(value: unknown, schema: __GhostTraceJsonSchema, path = '$'): readonly string[] {
  if (schema.type === 'unknown') {
    return [];
  }
  if (schema.type === 'null') {
    return value === null ? [] : [\`\${path} expected null\`];
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return [\`\${path} expected array\`];
    }
    return value.flatMap((entry, index) => __ghosttraceValidateJsonSchema(entry, schema.items ?? { type: 'unknown' }, \`\${path}[\${index}]\`));
  }
  if (schema.type === 'object') {
    if (!__ghosttraceIsRecord(value)) {
      return [\`\${path} expected object\`];
    }
    const requiredErrors = (schema.required ?? []).flatMap((key) =>
      Object.prototype.hasOwnProperty.call(value, key) ? [] : [\`\${path}.\${key} is required\`]
    );
    const propertyErrors = Object.entries(schema.properties ?? {}).flatMap(([key, propertySchema]) =>
      Object.prototype.hasOwnProperty.call(value, key)
        ? __ghosttraceValidateJsonSchema(value[key], propertySchema, \`\${path}.\${key}\`)
        : []
    );
    return [...requiredErrors, ...propertyErrors];
  }
  if (schema.type === 'number') {
    return typeof value === 'number' || typeof value === 'bigint' ? [] : [\`\${path} expected number\`];
  }
  return typeof value === schema.type ? [] : [\`\${path} expected \${schema.type}\`];
}

function __ghosttraceRecordString(value: unknown, key: string): string | undefined {
  if (!__ghosttraceIsRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

function __ghosttraceSideEffectMatches(span: { readonly type: unknown; readonly name: unknown; readonly input: unknown; readonly metadata: unknown }, expected: __GhostTraceExpectedSideEffect): boolean {
  if (span.type !== expected.type || span.name !== expected.name) {
    return false;
  }

  const input = __ghosttraceDeserialize(span.input);
  const metadata = __ghosttraceDeserialize(span.metadata);
  if (expected.url !== undefined && __ghosttraceRecordString(input, 'url') !== expected.url && __ghosttraceRecordString(metadata, 'url') !== expected.url) {
    return false;
  }
  if (expected.method !== undefined && __ghosttraceRecordString(input, 'method') !== expected.method && __ghosttraceRecordString(metadata, 'method') !== expected.method) {
    return false;
  }
  if (expected.query !== undefined && __ghosttraceRecordString(input, 'query') !== expected.query && __ghosttraceRecordString(metadata, 'query') !== expected.query) {
    return false;
  }
  if (expected.operation !== undefined && __ghosttraceRecordString(input, 'operation') !== expected.operation && __ghosttraceRecordString(metadata, 'operation') !== expected.operation) {
    return false;
  }
  return true;
}
`.trim();

function assertionLines(style: TestAssertionStyle): readonly string[] {
  if (style === 'snapshot') {
    return ['    expect(__ghosttraceReplayResult.output).toMatchSnapshot();'];
  }
  if (style === 'schema') {
    return [
      '    const __ghosttraceOutputSchema = __ghosttraceJsonSchemaFromValue(__ghosttraceDeserialize(__ghosttraceCase.output));',
      '    const __ghosttraceSchemaErrors = __ghosttraceValidateJsonSchema(__ghosttraceReplayResult.output, __ghosttraceOutputSchema);',
      '    expect(__ghosttraceSchemaErrors).toEqual([]);'
    ];
  }

  return ['    expect(__ghosttraceReplayResult.output).toEqual(__ghosttraceDeserialize(__ghosttraceCase.output));'];
}

function sideEffectAssertionLines(assertSideEffects: boolean): readonly string[] {
  if (!assertSideEffects) {
    return [];
  }

  return [
    '    for (const __ghosttraceExpectedSideEffect of __ghosttraceExpectedSideEffects) {',
    '      const __ghosttraceSideEffectMatched = __ghosttraceReplayResult.spansMatched.some((match) =>',
    '        __ghosttraceSideEffectMatches(match.span, __ghosttraceExpectedSideEffect)',
    '      );',
    '      expect(__ghosttraceSideEffectMatched).toBe(true);',
    '    }'
  ];
}

function testCaseCode(testCase: GeneratedTestCase, index: number, style: TestAssertionStyle, assertSideEffects: boolean): string {
  const lines = [
    `  it(${singleQuotedStringLiteral(`replays ${testCase.name}`)}, async () => {`,
    `    const __ghosttraceCase = __ghosttraceGetCase(${index});`,
    `    const __ghosttraceReplayResult = await ghost.replay(__ghosttraceTrace, async () => __ghosttraceInvokeTracedFunction(${singleQuotedStringLiteral(testCase.functionName)}, __ghosttraceDeserialize(__ghosttraceCase.input)));`,
    ...assertionLines(style),
    ...sideEffectAssertionLines(assertSideEffects),
    '  });'
  ];

  return lines.join('\n');
}

function header(framework: TestGenerationFramework, modulePath: string): string {
  return [
    '/* Generated by GhostTrace regression test generation. */',
    '/* eslint-disable */',
    frameworkImport(framework),
    "import { ghost, type Trace } from 'ghosttrace';",
    `import * as __ghosttraceSubject from ${singleQuotedStringLiteral(modulePath)};`
  ].join('\n');
}

/** Generates a runnable Vitest or Jest replay regression test file from a trace. */
export function generateTests(trace: Trace, options: GenerateTestsOptions = {}): string {
  const framework = normalizeFramework(options.framework);
  const assertionStyle = normalizeAssertionStyle(options.assertionStyle);
  const modulePath = options.modulePath ?? './subject.js';
  const cases = testCases(trace, options);
  const sideEffects = expectedSideEffects(trace);
  const sections = [
    header(framework, modulePath),
    RUNTIME_HELPERS,
    `const __ghosttraceTrace = ${jsonLiteral(generatedTrace(trace))} as const satisfies Trace;`,
    `const __ghosttraceTestCases = ${jsonLiteral(cases)} as const satisfies readonly __GhostTraceTestCase[];`,
    `const __ghosttraceExpectedSideEffects = ${jsonLiteral(sideEffects)} as const satisfies readonly __GhostTraceExpectedSideEffect[];`,
    [
      `describe(${singleQuotedStringLiteral(`GhostTrace replay: ${trace.name}`)}, () => {`,
      cases.map((testCase, index) => testCaseCode(testCase, index, assertionStyle, options.assertSideEffects ?? false)).join('\n\n'),
      '});'
    ].join('\n')
  ];

  return `${sections.join('\n\n')}\n`;
}
