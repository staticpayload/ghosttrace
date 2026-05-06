import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SpanType,
  deserialize,
  generateMocks,
  ghost,
  wrap,
  wrapDb,
  type DbAdapter,
  type GhostTracePlugin,
  type SerializedJsonValue,
  type Span,
  type Trace
} from '../../src/index.js';
import { createFrameworkRecordReplayContext } from '../../src/integrations/shared.js';

const projectRoot = resolve(__dirname, '../..');
const cliSourcePath = join(projectRoot, 'src/cli/index.ts');
const requireFromTest = createRequire(import.meta.url);
const tsxLoaderPath = requireFromTest.resolve('tsx');
const originalFetch = globalThis.fetch;
const tempRoots: string[] = [];
const cliTestTimeoutMs = 30_000;

type FetchImplementation = typeof globalThis.fetch;
type RuntimeMock = (...args: readonly unknown[]) => unknown;
type RuntimeModule = Readonly<Record<string, unknown>>;

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
}

interface HttpPayload {
  readonly source: string;
  readonly userId: number;
}

interface DbRow {
  readonly id: number;
  readonly name: string;
}

interface DbResult {
  readonly rows: readonly DbRow[];
  readonly rowCount: number;
}

interface FakeDbClient {
  query: (sql: string, params?: readonly unknown[]) => Promise<DbResult>;
}

interface CrossAreaOutput {
  readonly http: HttpPayload;
  readonly db: readonly DbRow[];
  readonly file: string;
}

const fakeDbAdapter: DbAdapter<FakeDbClient> = {
  name: 'memory-db',
  operations: [
    {
      method: 'query'
    }
  ]
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ghosttrace-cross-area-core-'));
  tempRoots.push(root);
  return root;
}

function runGhost(
  cwd: string,
  args: readonly string[],
  envOverrides: Readonly<Record<string, string | undefined>> = {},
  timeout = 15_000
): CliResult {
  const result = spawnSync(process.execPath, ['--import', tsxLoaderPath, cliSourcePath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...envOverrides
    },
    timeout
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    signal: result.signal
  };
}

async function withFetch<TValue>(
  implementation: FetchImplementation,
  fn: () => Promise<TValue>
): Promise<TValue> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = implementation;

  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function recordedFetch(payload: HttpPayload): FetchImplementation {
  return async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
}

const offlineFetch: FetchImplementation = async () => {
  throw new Error('network is offline during replay');
};

async function runCrossAreaFlow(client: FakeDbClient, filePath: string): Promise<CrossAreaOutput> {
  const fsPromises = await import('node:fs/promises');
  const response = await fetch('https://api.example.test/users/1', {
    headers: {
      accept: 'application/json'
    }
  });
  const httpPayload = await response.json() as HttpPayload;
  const dbResult = await client.query('select * from users where id = $1', [httpPayload.userId]);
  const file = await fsPromises.readFile(filePath, 'utf8');

  return {
    http: httpPayload,
    db: dbResult.rows,
    file
  };
}

function rootFunctionSpan(trace: Trace): Span {
  const span = trace.spans.find((candidate) => candidate.parentId === null && candidate.type === SpanType.Function);
  if (span === undefined) {
    throw new Error(`Trace ${trace.name} does not contain a root function span`);
  }

  return span;
}

function deserializeTraceValue<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

function parseTrace(text: string): Trace {
  return JSON.parse(text) as Trace;
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

describe('cross-area core flows', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('round-trips record → save → load → replay and replays only selected types in partial mode', async () => {
    const root = await tempRoot();
    const filePath = join(root, 'profile.txt');
    const tracePath = join(root, 'roundtrip.ghosttrace.json');
    const httpPayload: HttpPayload = { source: 'recorded-http', userId: 1 };
    const recordedRows: readonly DbRow[] = [{ id: 1, name: 'recorded-db' }];
    const liveRows: readonly DbRow[] = [{ id: 1, name: 'live-db' }];
    const expectedRecordedOutput: CrossAreaOutput = {
      http: httpPayload,
      db: recordedRows,
      file: 'recorded-file'
    };
    const expectedPartialOutput: CrossAreaOutput = {
      http: httpPayload,
      db: liveRows,
      file: 'live-file'
    };
    let dbCalls = 0;
    const liveDb: FakeDbClient = {
      query: async () => {
        dbCalls += 1;
        return { rows: recordedRows, rowCount: recordedRows.length };
      }
    };
    const db = wrapDb(liveDb, fakeDbAdapter);

    await writeFile(filePath, 'recorded-file', 'utf8');
    const trace = await withFetch(recordedFetch(httpPayload), () =>
      ghost.record('cross-area-roundtrip', () => runCrossAreaFlow(db, filePath), {
        interceptors: ['http', 'db', 'fs']
      })
    );
    const savedPath = await trace.save({ filePath: tracePath });
    const loadedTrace = await ghost.loadTrace(savedPath);
    const validation = await ghost.validateTrace(savedPath);

    expect(validation).toMatchObject({ valid: true, errors: [] });
    expect(deserializeTraceValue<CrossAreaOutput>(rootFunctionSpan(loadedTrace).output)).toEqual(expectedRecordedOutput);

    await writeFile(filePath, 'live-file', 'utf8');
    liveDb.query = async () => {
      dbCalls += 1;
      throw new Error('strict replay should not call the live DB implementation');
    };

    const strictReplay = await withFetch(offlineFetch, () =>
      ghost.replay(loadedTrace, () => runCrossAreaFlow(db, filePath))
    );

    expect(strictReplay.output).toEqual(expectedRecordedOutput);
    expect(strictReplay.spansMatched.map((match) => match.span.type).sort()).toEqual([
      SpanType.Db,
      SpanType.Fs,
      SpanType.Http
    ].sort());
    expect(dbCalls).toBe(1);

    liveDb.query = async () => {
      dbCalls += 1;
      return { rows: liveRows, rowCount: liveRows.length };
    };
    const partialReplay = await withFetch(offlineFetch, () =>
      ghost.replay(loadedTrace, () => runCrossAreaFlow(db, filePath), {
        mode: 'partial',
        replayTypes: [SpanType.Http]
      })
    );

    expect(partialReplay.output).toEqual(expectedPartialOutput);
    expect(partialReplay.spansMatched.map((match) => match.span.type)).toEqual([SpanType.Http]);
    expect(dbCalls).toBe(2);
  });

  it('records sensitive data, redacts it, and exports HTML without leaking original secrets', async () => {
    const rawApiKey = 'sk_live_1234567890abcdef';
    const rawEmail = 'security@example.test';
    const trace = await ghost.record('redacted-html-flow', () => ({
      apiKey: rawApiKey,
      nested: {
        email: rawEmail
      }
    }), {
      redaction: {}
    });
    const html = await ghost.exportTrace(trace, { format: 'html' });
    const traceJson = JSON.stringify(trace);

    expect(traceJson).not.toContain(rawApiKey);
    expect(traceJson).not.toContain(rawEmail);
    expect(html).not.toContain(rawApiKey);
    expect(html).not.toContain(rawEmail);
    expect(html).toContain('[REDACTED:API_KEY]');
    expect(html).toContain('[REDACTED:EMAIL]');
  });

  it('generates executable mocks from a recording and uses them to reproduce the recorded output', async () => {
    const expectedInvoice = { subtotal: 42, tax: 4.2, total: 46.2 };
    function calculateInvoice(): typeof expectedInvoice {
      return expectedInvoice;
    }

    const wrappedCalculateInvoice = wrap(calculateInvoice);
    const trace = await ghost.record('mock-generation-cross-area', () => wrappedCalculateInvoice(), {
      interceptors: ['function']
    });
    const source = generateMocks(trace, {
      format: 'function',
      filter: {
        type: SpanType.Function,
        name: 'calculateInvoice'
      }
    });

    expectValidTypeScript(source);
    const moduleExports = await importGenerated(source);
    const calculateInvoiceMock = mockExport(moduleExports, 'calculateInvoice');

    expect(calculateInvoiceMock()).toEqual(expectedInvoice);
  });

  it('diffs identical re-records as identical and pinpoints output drift in modified recordings', async () => {
    let delta = 0;
    function calculateContract(): { readonly status: string; readonly total: number } {
      return {
        status: 'ok',
        total: 100 + delta
      };
    }
    const wrappedCalculateContract = wrap(calculateContract);

    delta = 0;
    const baseline = await ghost.record('diff-cross-area', () => wrappedCalculateContract(), {
      interceptors: ['function']
    });
    delta = 0;
    const identicalRerecord = await ghost.record('diff-cross-area', () => wrappedCalculateContract(), {
      interceptors: ['function']
    });
    const identicalDiff = ghost.diff(baseline, identicalRerecord);

    expect(identicalDiff.status).toBe('identical');
    expect(identicalDiff.stats.total).toBe(0);

    delta = 25;
    const modifiedRerecord = await ghost.record('diff-cross-area', () => wrappedCalculateContract(), {
      interceptors: ['function']
    });
    const modifiedDiff = ghost.diff(baseline, modifiedRerecord);
    const outputChange = modifiedDiff.changes.find((change) =>
      change.type === 'changed' &&
      change.field.endsWith('output.total') &&
      change.baseline === 100 &&
      change.current === 125
    );

    expect(modifiedDiff.status).toBe('drift');
    expect(outputChange).toBeDefined();
    expect(outputChange?.spanPath).toMatch(/^\$\.spans\[\d+\]$/u);
  });

  it('keeps CLI record, inspect, and JSON export output consistent with the trace file', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'cli-cross-area.ghosttrace.json');
    await writeFile(
      join(root, 'flow.ts'),
      [
        'export function buildReport(id: number) {',
        "  return { id, label: `report-${id}`, source: 'cli-record' };",
        '}'
      ].join('\n'),
      'utf8'
    );

    const recordResult = runGhost(root, [
      'record',
      './flow.ts',
      'buildReport',
      '--args',
      '[7]',
      '--output',
      tracePath,
      '--name',
      'cli cross area',
      '--interceptors',
      'function'
    ], {}, cliTestTimeoutMs);

    expect(recordResult.status).toBe(0);
    expect(recordResult.stdout).toContain('Trace saved to');
    expect(existsSync(tracePath)).toBe(true);

    const savedTrace = parseTrace(await readFile(tracePath, 'utf8'));
    const functionSpanCount = savedTrace.spans.filter((span) => span.type === SpanType.Function).length;
    const inspectSummary = runGhost(root, ['inspect', tracePath], {}, cliTestTimeoutMs);
    const inspectSpans = runGhost(root, ['inspect', tracePath, '--spans'], {}, cliTestTimeoutMs);
    const exportJson = runGhost(root, ['export', tracePath, '--format', 'json'], {}, cliTestTimeoutMs);

    expect(inspectSummary.status).toBe(0);
    expect(inspectSummary.stdout).toContain(`Name: ${savedTrace.name}`);
    expect(inspectSummary.stdout).toContain(`Spans: ${savedTrace.spans.length}`);
    expect(inspectSummary.stdout).toContain(`function: ${functionSpanCount}`);
    expect(inspectSpans.status).toBe(0);
    for (const span of savedTrace.spans) {
      expect(inspectSpans.stdout).toContain(span.id);
      expect(inspectSpans.stdout).toContain(span.name);
    }

    expect(exportJson.status).toBe(0);
    const exportedTrace = deserialize<Trace>(JSON.parse(exportJson.stdout) as SerializedJsonValue);
    expect(exportedTrace.name).toBe(savedTrace.name);
    expect(exportedTrace.spans.map((span) => span.id)).toEqual(savedTrace.spans.map((span) => span.id));
    expect(exportedTrace.spans.map((span) => span.name)).toEqual(savedTrace.spans.map((span) => span.name));
    expect(deserializeTraceValue(rootFunctionSpan(exportedTrace).output)).toEqual(
      deserializeTraceValue(rootFunctionSpan(savedTrace).output)
    );
  }, cliTestTimeoutMs);

  it('applies plugin transforms before framework save and uses the transformed trace during replay', async () => {
    const root = await tempRoot();
    const traceDir = join(root, 'framework-traces');
    const envKey = 'GHOSTTRACE_CROSS_AREA_PLUGIN_FRAMEWORK';
    const events: string[] = [];
    const plugin: GhostTracePlugin = {
      name: 'framework-lifecycle-plugin',
      version: '1.0.0',
      hooks: {
        beforeRecord: () => {
          events.push('beforeRecord');
        },
        afterRecord: (trace) => ({
          ...trace,
          metadata: {
            ...trace.metadata,
            pluginStage: 'afterRecord',
            transformedByPlugin: true
          }
        }),
        beforeReplay: (trace) => {
          events.push(`beforeReplay:${String(trace.metadata.pluginStage)}`);
          return {
            ...trace,
            metadata: {
              ...trace.metadata,
              pluginStage: 'beforeReplay'
            }
          };
        },
        afterReplay: (trace) => {
          events.push(`afterReplay:${String(trace.metadata.pluginStage)}`);
        }
      }
    };
    const lifecycle = createFrameworkRecordReplayContext({
      framework: 'vitest',
      fallbackTraceName: 'cross-area-framework-plugin',
      testName: 'cross area plugin framework lifecycle',
      traceOptions: {
        traceDir,
        interceptors: ['env'],
        plugins: [plugin]
      }
    });

    process.env[envKey] = 'recorded-plugin-value';
    await expect(lifecycle.record(() => process.env[envKey])).resolves.toBe('recorded-plugin-value');
    const savedTrace = parseTrace(await readFile(lifecycle.traceFile, 'utf8'));
    expect(savedTrace.metadata.transformedByPlugin).toBe(true);
    expect(savedTrace.metadata.pluginStage).toBe('afterRecord');

    process.env[envKey] = 'live-plugin-value';
    await expect(lifecycle.record(() => process.env[envKey])).resolves.toBe('recorded-plugin-value');
    expect(lifecycle.spans.map((span) => span.type)).toContain(SpanType.Env);
    expect(events).toEqual([
      'beforeRecord',
      'beforeReplay:afterRecord',
      'afterReplay:beforeReplay'
    ]);

    delete process.env[envKey];
  });
});
