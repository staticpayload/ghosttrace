import { describe, expect, expectTypeOf, it } from 'vitest';
import * as ts from 'typescript';
import {
  SpanType,
  TRACE_FORMAT_VERSION,
  generateFixtures,
  type GenerateFixturesOptions,
  type Span,
  type SpanError,
  type Trace
} from '../../src/index.js';

interface SpanOptions {
  readonly id: string;
  readonly type: SpanType;
  readonly name: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: SpanError | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface FixtureEntry {
  readonly spanId: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly error: unknown;
}

interface FixtureFile {
  readonly traceId: string;
  readonly traceName: string;
  readonly spanType: string;
  readonly spanName: string;
  readonly entries: readonly FixtureEntry[];
}

function span(options: SpanOptions): Span {
  return {
    id: options.id,
    parentId: null,
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
    id: 'trace_fixture_generation_test',
    name: 'fixture-generation-test',
    version: TRACE_FORMAT_VERSION,
    startTime: 0,
    endTime: spans.length,
    duration: spans.length,
    spans,
    metadata: {}
  };
}

function parseFixture(content: string): FixtureFile {
  return JSON.parse(content) as FixtureFile;
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

describe('generateFixtures', () => {
  it('returns a Map of JSON fixtures organized by span type and name with an index file', () => {
    const fixtures = generateFixtures(trace([
      span({ id: 'span_1', type: SpanType.Function, name: 'calculate', input: [1, 2], output: { sum: 3 } }),
      span({
        id: 'span_2',
        type: SpanType.Http,
        name: 'GET /users',
        input: { method: 'GET', url: 'https://api.example.test/users' },
        output: { status: 200, body: [{ id: 1 }] }
      })
    ]), { format: 'json' });

    expectTypeOf(fixtures).toEqualTypeOf<Map<string, string>>();
    expect(fixtures).toBeInstanceOf(Map);
    expect([...fixtures.keys()]).toEqual([
      'function/calculate.json',
      'http/get-users.json',
      'index.ts'
    ]);

    const functionFixture = parseFixture(fixtures.get('function/calculate.json') ?? '');
    expect(functionFixture).toMatchObject({
      traceId: 'trace_fixture_generation_test',
      traceName: 'fixture-generation-test',
      spanType: 'function',
      spanName: 'calculate'
    });
    expect(functionFixture.entries).toHaveLength(1);
    expect(functionFixture.entries[0]?.spanId).toBe('span_1');
    expect(functionFixture.entries[0]?.input).toMatchObject({
      __ghosttrace_tag: true,
      __type: 'Array',
      length: 2
    });
    expect(functionFixture.entries[0]?.output).toEqual({ sum: 3 });

    const indexSource = fixtures.get('index.ts') ?? '';
    expectValidTypeScript(indexSource);
    expect(indexSource).toContain("export { default as function_calculate } from './function/calculate.json';");
    expect(indexSource).toContain("export { default as http_get_users } from './http/get-users.json';");
  });

  it('emits TypeScript fixture files with as const assertions', () => {
    const fixtures = generateFixtures(trace([
      span({ id: 'span_1', type: SpanType.Function, name: 'calculate', input: [1, 2], output: { sum: 3 } })
    ]), { format: 'typescript' });
    const fixtureSource = fixtures.get('function/calculate.ts') ?? '';
    const indexSource = fixtures.get('index.ts') ?? '';

    expect([...fixtures.keys()]).toEqual(['function/calculate.ts', 'index.ts']);
    expect(fixtureSource).toContain('as const');
    expect(fixtureSource).toContain('export const fixture =');
    expect(indexSource).toContain("export { fixture as function_calculate } from './function/calculate.js';");
    expectValidTypeScript(fixtureSource);
    expectValidTypeScript(indexSource);
  });

  it('serializes non-JSON values with placeholder markers instead of throwing', () => {
    interface CircularValue {
      readonly label: string;
      self?: CircularValue;
    }

    const circular: CircularValue = { label: 'root' };
    circular.self = circular;

    const fixtures = generateFixtures(trace([
      span({ id: 'span_1', type: SpanType.Function, name: 'circular', output: { circular, bigint: 42n } })
    ]));
    const fixture = parseFixture(fixtures.get('function/circular.json') ?? '');

    expect(fixture.entries[0]?.output).toMatchObject({
      circular: {
        label: 'root',
        self: {
          __ghosttrace_tag: true,
          __type: 'CircularRef'
        }
      },
      bigint: {
        __ghosttrace_tag: true,
        __type: 'BigInt',
        value: '42'
      }
    });
  });

  it('supports filtering fixtures by span type and name', () => {
    const options = {
      format: 'json',
      filter: { type: SpanType.Http, name: /users/u }
    } satisfies GenerateFixturesOptions;
    const fixtures = generateFixtures(trace([
      span({ id: 'span_1', type: SpanType.Function, name: 'calculate', output: 3 }),
      span({ id: 'span_2', type: SpanType.Http, name: 'GET /users', output: { status: 200 } }),
      span({ id: 'span_3', type: SpanType.Http, name: 'GET /accounts', output: { status: 200 } })
    ]), options);

    expect([...fixtures.keys()]).toEqual(['http/get-users.json', 'index.ts']);
  });
});
