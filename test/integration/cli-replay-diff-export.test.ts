import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SpanType,
  createTrace,
  serialize,
  withTraceChecksum,
  type Span,
  type Trace
} from '../../src/index.js';

const projectRoot = resolve(__dirname, '../..');
const cliSourcePath = join(projectRoot, 'src/cli/index.ts');
const requireFromTest = createRequire(import.meta.url);
const tsxLoaderPath = requireFromTest.resolve('tsx');
const tempRoots: string[] = [];
const cliTestTimeoutMs = 20_000;

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
}

interface TestSpanOptions {
  readonly id: string;
  readonly type: SpanType;
  readonly name: string;
  readonly startTime?: number;
  readonly duration?: number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ghosttrace-cli-replay-diff-export-'));
  tempRoots.push(root);
  return root;
}

function runGhost(
  cwd: string,
  args: readonly string[],
  envOverrides: Readonly<Record<string, string | undefined>> = {},
  timeout = 10_000
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

function span(options: TestSpanOptions): Span {
  const startTime = options.startTime ?? 0;
  const duration = options.duration ?? 1;

  return {
    id: options.id,
    parentId: null,
    type: options.type,
    name: options.name,
    startTime,
    endTime: startTime + duration,
    duration,
    input: serialize(options.input ?? []),
    output: serialize(options.output),
    children: [],
    error: null,
    metadata: options.metadata ?? {}
  };
}

function trace(name: string, spans: readonly Span[]): Trace {
  const endTime = Math.max(1, ...spans.map((traceSpan) => traceSpan.endTime));

  return withTraceChecksum(createTrace({
    id: `trace_${name.replaceAll(/[^A-Za-z0-9]+/gu, '_')}`,
    name,
    endTime,
    spans,
    metadata: {
      recordedAt: '2026-05-05T00:00:00.000Z'
    }
  }));
}

function replayTrace(name: string, output: unknown): Trace {
  return trace(name, [
    span({
      id: 'span_0001',
      type: SpanType.Function,
      name: 'run',
      output,
      metadata: {
        traceName: name
      }
    })
  ]);
}

async function writeTrace(path: string, value: Trace): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJsonOutput(stdout: string): unknown {
  return JSON.parse(stdout) as unknown;
}

describe('CLI replay, diff, and export commands', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('replays a matching function output with PASS and exit code 0', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'matching.ghosttrace.json');
    await writeTrace(tracePath, replayTrace('matching replay', 5));
    await writeFile(
      join(root, 'math.ts'),
      'export function add(left: number, right: number) { return left + right; }',
      'utf8'
    );

    const result = runGhost(root, ['replay', tracePath, './math.ts', 'add', '--args', '[2,3]']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stdout).toContain('matching replay');
  }, cliTestTimeoutMs);

  it('reports FAIL with output diff details and exit code 1 for divergent replay output', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'divergent.ghosttrace.json');
    await writeTrace(tracePath, replayTrace('divergent replay', { sum: 5 }));
    await writeFile(join(root, 'math.ts'), 'export function add() { return { sum: 6 }; }', 'utf8');

    const result = runGhost(root, ['replay', tracePath, './math.ts', 'add']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain('mismatch');
    expect(result.stderr).toContain('Expected');
    expect(result.stderr).toContain('Actual');
    expect(result.stderr).toContain('sum');
  }, cliTestTimeoutMs);

  it('honors --mode by allowing lenient replay pass-through for unmatched side effects', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'lenient.ghosttrace.json');
    await writeTrace(tracePath, replayTrace('lenient replay', 'from-live-file'));
    await writeFile(join(root, 'live.txt'), 'from-live-file', 'utf8');
    await writeFile(
      join(root, 'fs.ts'),
      [
        "import * as fs from 'node:fs';",
        "export function readFileValue() { return fs.readFileSync('live.txt', 'utf8'); }"
      ].join('\n'),
      'utf8'
    );

    const result = runGhost(
      root,
      ['replay', tracePath, './fs.ts', 'readFileValue', '--mode', 'lenient']
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stdout).toContain('lenient');
  }, cliTestTimeoutMs);

  it('prints diff reports in terminal, json, and html formats', async () => {
    const root = await tempRoot();
    const baselinePath = join(root, 'baseline.ghosttrace.json');
    const currentPath = join(root, 'current.ghosttrace.json');
    await writeTrace(baselinePath, trace('baseline', [
      span({ id: 'span_0001', type: SpanType.Function, name: 'calculate', output: { value: 1 } })
    ]));
    await writeTrace(currentPath, trace('current', [
      span({ id: 'span_0001', type: SpanType.Function, name: 'calculate', output: { value: 2 } })
    ]));

    const terminal = runGhost(root, ['diff', baselinePath, currentPath, '--format', 'terminal']);
    expect(terminal.status).toBe(0);
    expect(terminal.stdout).toContain('Diff status: drift');
    expect(terminal.stdout).toContain('output.value');

    const json = runGhost(root, ['diff', baselinePath, currentPath, '--format', 'json']);
    expect(json.status).toBe(0);
    const jsonReport = parseJsonOutput(json.stdout) as { readonly status?: unknown; readonly changes?: readonly unknown[] };
    expect(jsonReport.status).toBe('drift');
    expect(jsonReport.changes).toHaveLength(1);

    const html = runGhost(root, ['diff', baselinePath, currentPath, '--format', 'html']);
    expect(html.status).toBe(0);
    expect(html.stdout).toContain('<!doctype html>');
    expect(html.stdout).toContain('id="diff-view"');
  }, cliTestTimeoutMs);

  it('exits 1 for --fail-on breaking when breaking changes exist', async () => {
    const root = await tempRoot();
    const baselinePath = join(root, 'baseline.ghosttrace.json');
    const currentPath = join(root, 'breaking-current.ghosttrace.json');
    await writeTrace(baselinePath, trace('baseline', [
      span({ id: 'span_0001', type: SpanType.Function, name: 'calculate', output: { value: 1 } })
    ]));
    await writeTrace(currentPath, trace('breaking current', [
      span({ id: 'span_0001', type: SpanType.Function, name: 'calculate', output: { value: 1 } }),
      span({ id: 'span_0002', type: SpanType.Timer, name: 'setTimeout(callback)', startTime: 2 })
    ]));

    const result = runGhost(root, ['diff', baselinePath, currentPath, '--fail-on', 'breaking']);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Diff status: breaking');
    expect(result.stderr).toContain('breaking');
  }, cliTestTimeoutMs);

  it('loads external diff rules files and reports missing rules files as errors', async () => {
    const root = await tempRoot();
    const baselinePath = join(root, 'baseline.ghosttrace.json');
    const currentPath = join(root, 'current.ghosttrace.json');
    const rulesPath = join(root, 'rules.json');
    await writeTrace(baselinePath, trace('baseline', [
      span({ id: 'span_0001', type: SpanType.Function, name: 'calculate', output: { value: 1 } })
    ]));
    await writeTrace(currentPath, trace('current', [
      span({ id: 'span_0001', type: SpanType.Function, name: 'calculate', output: { value: 1 } }),
      span({ id: 'span_0002', type: SpanType.Timer, name: 'setTimeout(callback)', startTime: 2 })
    ]));
    await writeFile(rulesPath, JSON.stringify({ allowNewSpans: true }), 'utf8');

    const withRules = runGhost(root, [
      'diff',
      baselinePath,
      currentPath,
      '--rules',
      rulesPath,
      '--fail-on',
      'breaking'
    ]);
    expect(withRules.status).toBe(0);
    expect(withRules.stdout).toContain('Diff status: drift');
    expect(withRules.stdout).toContain('Applied rules');

    const missingRules = runGhost(root, ['diff', baselinePath, currentPath, '--rules', join(root, 'missing-rules.json')]);
    expect(missingRules.status).toBe(1);
    expect(missingRules.stderr).toContain('Rules file not found');
  }, cliTestTimeoutMs);

  it('exports json, markdown, mermaid, and html to stdout and --output files', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'exportable.ghosttrace.json');
    await writeTrace(tracePath, trace('exportable', [
      span({ id: 'span_0001', type: SpanType.Function, name: 'calculate', output: { value: 1 } })
    ]));

    const expectations: Readonly<Record<string, (content: string) => void>> = {
      json: (content: string): void => {
        const exported = parseJsonOutput(content) as { readonly name?: unknown };
        expect(exported.name).toBe('exportable');
      },
      markdown: (content: string): void => {
        expect(content).toContain('# Trace: exportable');
      },
      mermaid: (content: string): void => {
        expect(content).toContain('sequenceDiagram');
      },
      html: (content: string): void => {
        expect(content).toContain('<!doctype html>');
      }
    };

    for (const [format, assertContent] of Object.entries(expectations)) {
      const stdoutResult = runGhost(root, ['export', tracePath, '--format', format]);
      expect(stdoutResult.status).toBe(0);
      assertContent(stdoutResult.stdout);

      const outputPath = join(root, `trace.${format}`);
      const outputResult = runGhost(root, ['export', tracePath, '--format', format, '--output', outputPath]);
      expect(outputResult.status).toBe(0);
      expect(outputResult.stdout).toContain(outputPath);
      expect(existsSync(outputPath)).toBe(true);
      assertContent(await readFile(outputPath, 'utf8'));
    }
  }, cliTestTimeoutMs);
});
