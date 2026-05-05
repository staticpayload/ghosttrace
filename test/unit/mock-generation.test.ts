import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  SpanType,
  TRACE_FORMAT_VERSION,
  generateMocks,
  serialize,
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

type RuntimeMock = (...args: readonly unknown[]) => unknown;
type RuntimeModule = Readonly<Record<string, unknown>>;

function span(options: SpanOptions): Span {
  return {
    id: options.id,
    parentId: null,
    type: options.type,
    name: options.name,
    startTime: 0,
    endTime: 1,
    duration: 1,
    input: serialize(options.input ?? []),
    output: serialize(options.output),
    children: [],
    error: options.error ?? null,
    metadata: options.metadata ?? {}
  };
}

function trace(spans: readonly Span[]): Trace {
  return {
    id: 'trace_mock_generation_test',
    name: 'mock-generation-test',
    version: TRACE_FORMAT_VERSION,
    startTime: 0,
    endTime: spans.length,
    duration: spans.length,
    spans,
    metadata: {}
  };
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

async function importGenerated(source: string): Promise<RuntimeModule> {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022
    }
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(result.outputText).toString('base64')}`;

  return import(dataUrl) as Promise<RuntimeModule>;
}

function mockExport(moduleExports: RuntimeModule, name: string): RuntimeMock {
  const exported = moduleExports[name];
  expect(exported).toBeTypeOf('function');
  return exported as RuntimeMock;
}

describe('generateMocks', () => {
  it('generates plain functions that return recorded values sequentially and throw when exhausted', async () => {
    const source = generateMocks(trace([
      span({ id: 'span_1', type: SpanType.Function, name: 'calculate', output: 'A' }),
      span({ id: 'span_2', type: SpanType.Function, name: 'calculate', output: 'B' }),
      span({ id: 'span_3', type: SpanType.Function, name: 'calculate', output: 'C' })
    ]), { format: 'function' });

    expectValidTypeScript(source);
    const moduleExports = await importGenerated(source);
    const calculate = mockExport(moduleExports, 'calculate');

    expect(calculate()).toBe('A');
    expect(calculate()).toBe('B');
    expect(calculate()).toBe('C');
    expect(() => calculate()).toThrow(/GhostTrace mock "calculate" exhausted after 3 call\(s\)/u);
  });

  it('emits framework-specific mock APIs for plain, Vitest, and Jest formats', () => {
    const sampleTrace = trace([
      span({ id: 'span_1', type: SpanType.Function, name: 'calculate', output: 1 }),
      span({ id: 'span_2', type: SpanType.Http, name: 'fetch', output: { ok: true } })
    ]);
    const functionSource = generateMocks(sampleTrace, { format: 'function' });
    const vitestSource = generateMocks(sampleTrace, { format: 'vitest-mock' });
    const jestSource = generateMocks(sampleTrace, { format: 'jest-mock' });

    for (const source of [functionSource, vitestSource, jestSource]) {
      expectValidTypeScript(source);
    }

    expect(functionSource).toContain('export function calculate');
    expect(vitestSource).toContain("import { vi } from 'vitest';");
    expect(vitestSource).toContain('vi.fn()');
    expect(vitestSource).toContain('.mockReturnValueOnce(');
    expect(vitestSource).toContain('.mockResolvedValueOnce(');
    expect(jestSource).toContain('declare const jest');
    expect(jestSource).toContain('jest.fn()');
    expect(jestSource).toContain('.mockReturnValueOnce(');
    expect(jestSource).toContain('.mockResolvedValueOnce(');
  });

  it('filters generated mocks by span type and name', () => {
    const sampleTrace = trace([
      span({ id: 'span_1', type: SpanType.Function, name: 'calculate', output: 1 }),
      span({ id: 'span_2', type: SpanType.Http, name: 'fetch', output: { ok: true } }),
      span({ id: 'span_3', type: SpanType.Db, name: 'db.query', output: [{ id: 1 }] })
    ]);
    const httpOnlySource = generateMocks(sampleTrace, { format: 'function', filter: { type: SpanType.Http } });
    const namedSource = generateMocks(sampleTrace, { format: 'function', filter: { name: 'calculate' } });

    expectValidTypeScript(httpOnlySource);
    expectValidTypeScript(namedSource);
    expect(httpOnlySource).toContain('export function fetch');
    expect(httpOnlySource).not.toContain('export function calculate');
    expect(httpOnlySource).not.toContain('db_query');
    expect(namedSource).toContain('export function calculate');
    expect(namedSource).not.toContain('export function fetch');
  });

  it('returns promises for async spans and throws recorded errors with matching type and message', async () => {
    const source = generateMocks(trace([
      span({
        id: 'span_1',
        type: SpanType.Function,
        name: 'asyncWork',
        output: { done: true },
        metadata: { isAsync: true }
      }),
      span({
        id: 'span_2',
        type: SpanType.Function,
        name: 'failSync',
        error: { name: 'TypeError', message: 'bad input' }
      }),
      span({
        id: 'span_3',
        type: SpanType.Function,
        name: 'failAsync',
        error: { name: 'RangeError', message: 'async bad' },
        metadata: { isAsync: true }
      })
    ]), { format: 'function', includeErrors: true });

    expectValidTypeScript(source);
    const moduleExports = await importGenerated(source);
    const asyncWork = mockExport(moduleExports, 'asyncWork');
    const failSync = mockExport(moduleExports, 'failSync');
    const failAsync = mockExport(moduleExports, 'failAsync');

    const asyncResult = asyncWork();
    expect(asyncResult).toBeInstanceOf(Promise);
    await expect(asyncResult).resolves.toEqual({ done: true });
    try {
      failSync();
      throw new Error('Expected failSync to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error).toMatchObject({ message: 'bad input' });
    }
    await expect(failAsync()).rejects.toMatchObject({ name: 'RangeError', message: 'async bad' });
  });

  it('excludes error spans when includeErrors is false', () => {
    const sampleTrace = trace([
      span({
        id: 'span_1',
        type: SpanType.Function,
        name: 'failSync',
        error: { name: 'TypeError', message: 'bad input' }
      })
    ]);

    expect(generateMocks(sampleTrace, { format: 'function', includeErrors: false })).not.toContain('failSync');
    expect(generateMocks(sampleTrace, { format: 'function', includeErrors: true })).toContain('failSync');
  });

  it('normalizes structured env timer and filesystem outputs to runtime return values', async () => {
    const source = generateMocks(trace([
      span({
        id: 'span_1',
        type: SpanType.Env,
        name: 'process.env.get',
        output: { value: 'recorded-env-value', exists: true }
      }),
      span({
        id: 'span_2',
        type: SpanType.Timer,
        name: 'Date.now',
        output: { value: 1_702_000_000_000 }
      }),
      span({
        id: 'span_3',
        type: SpanType.Fs,
        name: 'fs.promises.writeFile',
        output: { success: true },
        metadata: { api: 'promises', operation: 'writeFile' }
      })
    ]), { format: 'function' });

    expectValidTypeScript(source);
    const moduleExports = await importGenerated(source);
    const envGet = mockExport(moduleExports, 'process_env_get');
    const dateNow = mockExport(moduleExports, 'Date_now');
    const writeFile = mockExport(moduleExports, 'fs_promises_writeFile');

    expect(envGet()).toBe('recorded-env-value');
    expect(dateNow()).toBe(1_702_000_000_000);
    await expect(writeFile()).resolves.toBeUndefined();
  });

  it('normalizes new Date timer span output to the recorded ISO value', async () => {
    const source = generateMocks(trace([
      span({
        id: 'span_1',
        type: SpanType.Timer,
        name: 'new Date',
        output: {
          timestamp: 1_702_000_000_000,
          iso: '2023-12-08T01:46:40.000Z'
        },
        metadata: { operation: 'new Date' }
      })
    ]), { format: 'function' });

    expectValidTypeScript(source);
    const moduleExports = await importGenerated(source);
    const newDate = mockExport(moduleExports, 'new_Date');

    expect(newDate()).toBe('2023-12-08T01:46:40.000Z');
  });
});
