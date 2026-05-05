import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ghosttrace-cli-'));
  tempRoots.push(root);
  return root;
}

function runGhost(cwd: string, args: readonly string[], timeout = 10_000): CliResult {
  const result = spawnSync(process.execPath, ['--import', tsxLoaderPath, cliSourcePath, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1'
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

async function readJsonFile(path: string): Promise<Readonly<Record<string, unknown>>> {
  return JSON.parse(await readFile(path, 'utf8')) as Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('CLI init and record commands', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('initializes an idempotent config and trace directory with detected framework metadata', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '^4.0.0' } }),
      'utf8'
    );

    const firstRun = runGhost(root, ['init']);

    expect(firstRun.status).toBe(0);
    expect(firstRun.stdout).toContain('Detected framework: vitest');
    expect(existsSync(join(root, '__ghosttraces__'))).toBe(true);

    const configPath = join(root, 'ghosttrace.config.ts');
    const firstConfig = await readFile(configPath, 'utf8');
    expect(firstConfig).toContain("import { defineConfig } from 'ghosttrace';");
    expect(firstConfig).toContain("traceDir: '__ghosttraces__'");
    expect(firstConfig).toContain("framework: 'vitest'");

    const secondRun = runGhost(root, ['init']);

    expect(secondRun.status).toBe(0);
    expect(secondRun.stdout).toContain('already exists');
    await expect(readFile(configPath, 'utf8')).resolves.toBe(firstConfig);
  }, cliTestTimeoutMs);

  it('records a TypeScript module export with args, name, output, and interceptor options', async () => {
    const root = await tempRoot();
    const modulePath = join(root, 'math.ts');
    const outputPath = join(root, 'custom-output.ghosttrace.json');
    await writeFile(
      modulePath,
      [
        'export function add(left: number, right: number) {',
        '  return { sum: left + right };',
        '}'
      ].join('\n'),
      'utf8'
    );

    const result = runGhost(root, [
      'record',
      './math.ts',
      'add',
      '--args',
      '[2,3]',
      '--name',
      'custom add trace',
      '--output',
      outputPath,
      '--interceptors',
      'function'
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(outputPath);
    expect(existsSync(outputPath)).toBe(true);

    const trace = await readJsonFile(outputPath);
    expect(trace.name).toBe('custom add trace');
    expect(trace.metadata).toMatchObject({ name: 'custom add trace' });
    expect(trace.spans).toEqual(expect.any(Array));

    const spans = trace.spans as readonly unknown[];
    const functionSpan = spans.find(
      (span) => isRecord(span) && span.name === 'add' && Array.isArray(span.input)
    );

    expect(functionSpan).toMatchObject({
      name: 'add',
      input: [2, 3],
      output: { sum: 5 },
      error: null
    });
  }, cliTestTimeoutMs);

  it('uses the default trace directory when no output path is provided', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'module.ts'), 'export function greet() { return "hello"; }', 'utf8');

    const result = runGhost(root, ['record', './module.ts', 'greet', '--interceptors', 'function']);

    expect(result.status).toBe(0);
    const traceDir = join(root, '__ghosttraces__');
    const traceFiles = readdirSync(traceDir).filter((fileName) => fileName.endsWith('.ghosttrace.json'));
    expect(traceFiles).toHaveLength(1);
    expect(result.stdout).toContain(join(traceDir, traceFiles[0] ?? ''));
  }, cliTestTimeoutMs);

  it('loads TypeScript config defaults when recording without equivalent flags', async () => {
    const root = await tempRoot();
    const configImportPath = join(projectRoot, 'src/index.ts').replaceAll('\\', '/');
    await writeFile(
      join(root, 'ghosttrace.config.ts'),
      [
        `import { defineConfig } from ${JSON.stringify(configImportPath)};`,
        'export default defineConfig({',
        "  traceDir: 'configured-traces',",
        "  interceptors: ['function'],",
        "  metadata: { configured: true }",
        '});'
      ].join('\n'),
      'utf8'
    );
    await writeFile(join(root, 'module.ts'), 'export function greet(name: string) { return `hello ${name}`; }', 'utf8');

    const result = runGhost(root, ['record', './module.ts', 'greet', '--args', '["Ada"]']);

    expect(result.status).toBe(0);
    const traceDir = join(root, 'configured-traces');
    const traceFiles = readdirSync(traceDir).filter((fileName) => fileName.endsWith('.ghosttrace.json'));
    expect(traceFiles).toHaveLength(1);

    const trace = await readJsonFile(join(traceDir, traceFiles[0] ?? ''));
    expect(trace.metadata).toMatchObject({ configured: true });
    const spans = trace.spans as readonly unknown[];
    expect(
      spans.find(
        (span) => isRecord(span) && span.name === 'greet' && Array.isArray(span.input) && span.input.length === 1
      )
    ).toMatchObject({
      input: ['Ada'],
      output: 'hello Ada'
    });
  }, cliTestTimeoutMs);

  it('reports missing files and missing exports with exit code 1', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'module.ts'), 'export const value = 1;', 'utf8');

    const missingFile = runGhost(root, ['record', './missing.ts', 'run']);
    const missingExport = runGhost(root, ['record', './module.ts', 'run']);

    expect(missingFile.status).toBe(1);
    expect(missingFile.stderr).toContain('not found');
    expect(missingExport.status).toBe(1);
    expect(missingExport.stderr).toContain('run');
  }, cliTestTimeoutMs);

  it('saves a trace with captured error details when the target function throws', async () => {
    const root = await tempRoot();
    const outputPath = join(root, 'throws.ghosttrace.json');
    await writeFile(
      join(root, 'thrower.ts'),
      'export function boom() { throw new TypeError("kaboom"); }',
      'utf8'
    );

    const result = runGhost(root, [
      'record',
      './thrower.ts',
      'boom',
      '--output',
      outputPath,
      '--interceptors',
      'function'
    ]);

    expect(result.status).toBe(0);
    const trace = await readJsonFile(outputPath);
    const spans = trace.spans as readonly unknown[];
    const errorSpan = spans.find((span) => isRecord(span) && isRecord(span.error));

    expect(errorSpan).toMatchObject({
      name: 'boom',
      error: {
        name: 'TypeError',
        message: 'kaboom'
      }
    });
  }, cliTestTimeoutMs);

  it('aborts timed-out recordings with exit code 1 and without a partial trace', async () => {
    const root = await tempRoot();
    const outputPath = join(root, 'timeout.ghosttrace.json');
    await writeFile(
      join(root, 'slow.ts'),
      [
        'export async function wait() {',
        '  await new Promise((resolve) => setTimeout(resolve, 500));',
        '  return "late";',
        '}'
      ].join('\n'),
      'utf8'
    );

    const result = runGhost(root, [
      'record',
      './slow.ts',
      'wait',
      '--timeout',
      '50',
      '--output',
      outputPath
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('timed out');
    expect(existsSync(outputPath)).toBe(false);
  }, cliTestTimeoutMs);
});
