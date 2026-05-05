import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
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
  readonly parentId?: string | null;
  readonly startTime?: number;
  readonly duration?: number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ghosttrace-cli-inspect-generate-'));
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
    parentId: options.parentId ?? null,
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

function sampleTrace(name = 'sample inspect trace'): Trace {
  const functionSpan = span({
    id: 'span_0001',
    type: SpanType.Function,
    name: 'run',
    input: [2, 3],
    output: { sum: 5 },
    metadata: {
      traceName: name
    }
  });
  const httpSpan = span({
    id: 'span_0002',
    parentId: 'span_0001',
    type: SpanType.Http,
    name: 'GET https://api.example.test/users',
    startTime: 1,
    input: {
      method: 'GET',
      url: 'https://api.example.test/users'
    },
    output: {
      status: 200,
      body: [{ id: 1, name: 'Ada' }]
    },
    metadata: {
      method: 'GET',
      url: 'https://api.example.test/users'
    }
  });

  return withTraceChecksum(createTrace({
    id: `trace_${name.replaceAll(/[^A-Za-z0-9]+/gu, '_')}`,
    name,
    endTime: 3,
    spans: [
      {
        ...functionSpan,
        children: [httpSpan]
      },
      httpSpan
    ],
    metadata: {
      recordedAt: '2026-05-05T00:00:00.000Z'
    }
  }));
}

async function writeTrace(path: string, value: Trace): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('CLI inspect, generate, and conventions', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('inspects a trace summary, span list, specific span detail, and validation result', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'inspectable.ghosttrace.json');
    await writeTrace(tracePath, sampleTrace());

    const summary = runGhost(root, ['inspect', tracePath]);
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain('Trace summary');
    expect(summary.stdout).toContain('sample inspect trace');
    expect(summary.stdout).toContain('Spans: 2');
    expect(summary.stdout).toContain('function: 1');
    expect(summary.stdout).toContain('http: 1');

    const spanList = runGhost(root, ['inspect', tracePath, '--spans']);
    expect(spanList.status).toBe(0);
    expect(spanList.stdout).toContain('Spans (2)');
    expect(spanList.stdout).toContain('span_0001');
    expect(spanList.stdout).toContain('span_0002');
    expect(spanList.stdout).toContain('GET https://api.example.test/users');

    const spanDetail = runGhost(root, ['inspect', tracePath, '--span', 'span_0002']);
    expect(spanDetail.status).toBe(0);
    expect(spanDetail.stdout).toContain('Span detail');
    expect(spanDetail.stdout).toContain('"id": "span_0002"');
    expect(spanDetail.stdout).toContain('"type": "http"');
    expect(spanDetail.stdout).toContain('api.example.test');

    const validation = runGhost(root, ['inspect', tracePath, '--validate']);
    expect(validation.status).toBe(0);
    expect(validation.stdout).toContain('Trace valid');
    expect(validation.stdout).toContain('inspectable.ghosttrace.json');
  }, cliTestTimeoutMs);

  it('generates mocks, fixtures, and regression tests with framework-specific output', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'generatable.ghosttrace.json');
    await writeTrace(tracePath, sampleTrace('generatable trace'));

    const mocksDir = join(root, 'generated-mocks');
    const mocks = runGhost(root, ['generate', 'mocks', tracePath, '--framework', 'vitest', '--output', mocksDir]);
    expect(mocks.status).toBe(0);
    const mocksPath = join(mocksDir, 'mocks.ts');
    expect(existsSync(mocksPath)).toBe(true);
    await expect(readFile(mocksPath, 'utf8')).resolves.toContain("import { vi } from 'vitest';");

    const fixturesDir = join(root, 'generated-fixtures');
    const fixtures = runGhost(root, ['generate', 'fixtures', tracePath, '--framework', 'typescript', '--output', fixturesDir]);
    expect(fixtures.status).toBe(0);
    expect(existsSync(join(fixturesDir, 'index.ts'))).toBe(true);
    expect(readdirSync(join(fixturesDir, 'function')).some((fileName) => fileName.endsWith('.ts'))).toBe(true);
    await expect(readFile(join(fixturesDir, 'index.ts'), 'utf8')).resolves.toContain('fixturePaths');

    const testsDir = join(root, 'generated-tests');
    const tests = runGhost(root, ['generate', 'tests', tracePath, '--framework', 'jest', '--output', testsDir]);
    expect(tests.status).toBe(0);
    const generatedTest = join(testsDir, 'generatable-trace.test.ts');
    expect(existsSync(generatedTest)).toBe(true);
    await expect(readFile(generatedTest, 'utf8')).resolves.toContain("@jest/globals");
  }, cliTestTimeoutMs);

  it('reports generate error cases and missing arguments with exit code 1 and usage hints', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'valid.ghosttrace.json');
    await writeTrace(tracePath, sampleTrace('valid trace'));

    const missingFile = runGhost(root, ['generate', 'mocks', './missing.ghosttrace.json']);
    expect(missingFile.status).toBe(1);
    expect(missingFile.stderr).toContain('not found');

    const unknownSubcommand = runGhost(root, ['generate', 'unknown']);
    expect(unknownSubcommand.status).toBe(1);
    expect(unknownSubcommand.stderr).toContain('Unknown generate subcommand');
    expect(unknownSubcommand.stderr).toContain('mocks, fixtures, tests');

    const invalidFramework = runGhost(root, ['generate', 'mocks', tracePath, '--framework', 'invalid']);
    expect(invalidFramework.status).toBe(1);
    expect(invalidFramework.stderr).toContain('--framework');
    expect(invalidFramework.stderr).toContain('function, vitest, jest');

    const missingInspectArgs = runGhost(root, ['inspect']);
    expect(missingInspectArgs.status).toBe(1);
    expect(missingInspectArgs.stderr).toContain('Usage: ghost inspect');
  }, cliTestTimeoutMs);

  it('uses config defaults for omitted generate flags and supports help, version, NO_COLOR, and unknown command conventions', async () => {
    const root = await tempRoot();
    const tracePath = join(root, 'configurable.ghosttrace.json');
    const configImportPath = join(projectRoot, 'src/index.ts').replaceAll('\\', '/');
    await writeTrace(tracePath, sampleTrace('configurable trace'));
    await writeFile(
      join(root, 'ghosttrace.config.ts'),
      [
        `import { defineConfig } from ${JSON.stringify(configImportPath)};`,
        'export default defineConfig({',
        "  traceDir: 'configured-generated',",
        "  metadata: { framework: 'jest' }",
        '});'
      ].join('\n'),
      'utf8'
    );

    const configuredGenerate = runGhost(root, ['generate', 'tests', tracePath]);
    expect(configuredGenerate.status).toBe(0);
    const configuredTestPath = join(root, 'configured-generated', 'configurable-trace.test.ts');
    expect(existsSync(configuredTestPath)).toBe(true);
    await expect(readFile(configuredTestPath, 'utf8')).resolves.toContain("@jest/globals");

    const helpCommands: readonly (readonly string[])[] = [
      [],
      ['init'],
      ['record'],
      ['replay'],
      ['diff'],
      ['export'],
      ['inspect'],
      ['generate']
    ];
    for (const helpCommand of helpCommands) {
      const help = runGhost(root, [...helpCommand, '--help']);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Usage:');
    }

    const version = runGhost(root, ['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);

    const noColorUnknown = runGhost(root, ['wat'], { FORCE_COLOR: '1', NO_COLOR: '1' });
    expect(noColorUnknown.status).toBe(1);
    expect(noColorUnknown.stderr).toContain('Unknown command "wat"');
    expect(noColorUnknown.stderr).toContain('Available commands');
    expect(noColorUnknown.stderr).not.toMatch(/\u001B\[/u);
  }, cliTestTimeoutMs);
});
