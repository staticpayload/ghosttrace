import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  SpanType,
  TRACE_FORMAT_VERSION,
  generateTests,
  serialize,
  type GenerateTestsOptions,
  type Span,
  type SpanError,
  type Trace
} from '../../src/index.js';

interface SpanOptions {
  readonly id: string;
  readonly parentId?: string | null;
  readonly type: SpanType;
  readonly name: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: SpanError | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function span(options: SpanOptions): Span {
  return {
    id: options.id,
    parentId: options.parentId ?? null,
    type: options.type,
    name: options.name,
    startTime: 0,
    endTime: 1,
    duration: 1,
    input: options.input ?? [],
    output: options.output,
    children: [],
    error: options.error ?? null,
    metadata: options.metadata ?? {}
  };
}

function trace(spans: readonly Span[]): Trace {
  return {
    id: 'trace_test_generation_test',
    name: 'test-generation-test',
    version: TRACE_FORMAT_VERSION,
    startTime: 0,
    endTime: spans.length,
    duration: spans.length,
    spans,
    metadata: {}
  };
}

function sampleTrace(): Trace {
  return trace([
    span({
      id: 'span_1',
      type: SpanType.Function,
      name: 'calculate',
      input: [2, 3],
      output: { sum: 5 }
    }),
    span({
      id: 'span_2',
      parentId: 'span_1',
      type: SpanType.Http,
      name: 'fetch',
      input: { method: 'GET', url: 'https://api.example.test/users/1' },
      output: { status: 200, body: { id: 1 } }
    })
  ]);
}

function syntheticRootMultiCaseTrace(): Trace {
  return trace([
    span({
      id: 'span_root',
      type: SpanType.Function,
      name: 'recordedFlow',
      input: [],
      output: { ok: true },
      metadata: { traceName: 'recorded-flow' }
    }),
    span({
      id: 'span_case_a',
      parentId: 'span_root',
      type: SpanType.Function,
      name: 'lookupUser',
      input: [1],
      output: { id: 1 }
    }),
    span({
      id: 'span_http_a',
      parentId: 'span_case_a',
      type: SpanType.Http,
      name: 'fetch',
      input: { method: 'GET', url: 'https://api.example.test/users/1' },
      output: { status: 200, body: { id: 1 } }
    }),
    span({
      id: 'span_case_b',
      parentId: 'span_root',
      type: SpanType.Function,
      name: 'lookupUser',
      input: [2],
      output: { id: 2 }
    }),
    span({
      id: 'span_http_b',
      parentId: 'span_case_b',
      type: SpanType.Http,
      name: 'fetch',
      input: { method: 'GET', url: 'https://api.example.test/users/2' },
      output: { status: 200, body: { id: 2 } }
    })
  ]);
}

function extractGeneratedConst(source: string, constName: string): unknown {
  const marker = `const ${constName} = `;
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const valueStart = start + marker.length;
  const valueEnd = source.indexOf(' as const', valueStart);
  expect(valueEnd).toBeGreaterThan(valueStart);

  return JSON.parse(source.slice(valueStart, valueEnd)) as unknown;
}

function expectRecord(value: unknown): Readonly<Record<string, unknown>> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Readonly<Record<string, unknown>>;
}

function expectedSideEffects(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  const record = expectRecord(value);
  expect(record.sideEffects).toBeTypeOf('object');
  expect(Array.isArray(record.sideEffects)).toBe(true);
  return record.sideEffects as readonly Readonly<Record<string, unknown>>[];
}

function expectValidTypeScript(source: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      strict: true
    },
    reportDiagnostics: true
  });
  const diagnostics = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];

  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
}

describe('generateTests', () => {
  it('generates a runnable Vitest replay test that invokes the traced function and deep-equals output', () => {
    const source = generateTests(sampleTrace(), {
      framework: 'vitest',
      assertionStyle: 'deep-equal',
      modulePath: './calculator.js'
    });

    expectValidTypeScript(source);
    expect(source).toContain("import { describe, expect, it } from 'vitest';");
    expect(source).toContain("import * as __ghosttraceSubject from './calculator.js';");
    expect(source).toContain("await ghost.replay(__ghosttraceTrace, async () => __ghosttraceInvokeTracedFunction('calculate', __ghosttraceDeserialize(__ghosttraceCase.input)))");
    expect(source).toContain('expect(__ghosttraceReplayResult.output).toEqual(__ghosttraceDeserialize(__ghosttraceCase.output));');
  });

  it('generates Jest tests with the correct framework imports and structure', () => {
    const options = {
      framework: 'jest',
      assertionStyle: 'deep-equal',
      modulePath: './calculator.js'
    } satisfies GenerateTestsOptions;
    const source = generateTests(sampleTrace(), options);

    expectValidTypeScript(source);
    expect(source).toContain("import { describe, expect, it } from '@jest/globals';");
    expect(source).toContain("describe('GhostTrace replay: test-generation-test'");
    expect(source).toContain("it('replays calculate'");
    expect(source).toContain('expect(__ghosttraceReplayResult.output).toEqual(');
  });

  it('supports snapshot and schema assertion styles', () => {
    const snapshotSource = generateTests(sampleTrace(), {
      framework: 'vitest',
      assertionStyle: 'snapshot',
      modulePath: './calculator.js'
    });
    const schemaSource = generateTests(sampleTrace(), {
      framework: 'vitest',
      assertionStyle: 'schema',
      modulePath: './calculator.js'
    });

    expectValidTypeScript(snapshotSource);
    expectValidTypeScript(schemaSource);
    expect(snapshotSource).toContain('expect(__ghosttraceReplayResult.output).toMatchSnapshot();');
    expect(schemaSource).toContain('__ghosttraceOutputSchema');
    expect(schemaSource).toContain('__ghosttraceValidateJsonSchema(__ghosttraceReplayResult.output, __ghosttraceOutputSchema)');
    expect(schemaSource).toContain('expect(__ghosttraceSchemaErrors).toEqual([]);');
  });

  it('can assert HTTP side effects were replayed with recorded parameters', () => {
    const source = generateTests(sampleTrace(), {
      framework: 'vitest',
      assertionStyle: 'deep-equal',
      modulePath: './calculator.js',
      assertSideEffects: true
    });

    expectValidTypeScript(source);
    expect(source).toContain('"sideEffects": [');
    expect(source).toContain('"url": "https://api.example.test/users/1"');
    expect(source).toContain('__ghosttraceReplayResult.spansMatched.some');
    expect(source).toContain('expect(__ghosttraceSideEffectMatched).toBe(true);');
  });

  it('uses callable child function spans instead of the synthetic recorder root for test arguments', () => {
    const source = generateTests(trace([
      span({
        id: 'span_root',
        type: SpanType.Function,
        name: 'recordedFlow',
        input: [],
        output: { value: 'root-output' },
        metadata: { traceName: 'recorded-flow' }
      }),
      span({
        id: 'span_child',
        parentId: 'span_root',
        type: SpanType.Function,
        name: 'calculate',
        input: [7, 8],
        output: 15
      })
    ]), {
      framework: 'vitest',
      assertionStyle: 'deep-equal',
      modulePath: './calculator.js'
    });

    expectValidTypeScript(source);
    const cases = extractGeneratedConst(source, '__ghosttraceTestCases');
    expect(cases).toEqual([
      {
        spanId: 'span_child',
        name: 'calculate',
        functionName: 'calculate',
        input: serialize([7, 8]),
        output: 15,
        sideEffects: []
      }
    ]);
    expect(source).toContain("__ghosttraceInvokeTracedFunction('calculate'");
  });

  it('scopes expected side effects to the generated test case that owns each child span', () => {
    const source = generateTests(syntheticRootMultiCaseTrace(), {
      framework: 'vitest',
      assertionStyle: 'deep-equal',
      modulePath: './users.js',
      assertSideEffects: true
    });

    expectValidTypeScript(source);
    const cases = extractGeneratedConst(source, '__ghosttraceTestCases');
    expect(Array.isArray(cases)).toBe(true);
    const [firstCase, secondCase] = cases as readonly unknown[];

    expect(expectedSideEffects(firstCase)).toEqual([
      {
        type: 'http',
        name: 'fetch',
        url: 'https://api.example.test/users/1',
        method: 'GET'
      }
    ]);
    expect(expectedSideEffects(secondCase)).toEqual([
      {
        type: 'http',
        name: 'fetch',
        url: 'https://api.example.test/users/2',
        method: 'GET'
      }
    ]);
    expect(source).toContain('for (const __ghosttraceExpectedSideEffect of __ghosttraceCase.sideEffects)');
  });
});
