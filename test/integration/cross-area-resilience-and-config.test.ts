import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SpanType,
  TraceValidationError,
  deserialize,
  ghost,
  withTraceChecksum,
  wrap,
  type SerializedJsonValue,
  type Span,
  type Trace
} from '../../src/index.js';

const projectRoot = resolve(__dirname, '../..');
const cliSourcePath = join(projectRoot, 'src/cli/index.ts');
const requireFromTest = createRequire(import.meta.url);
const tsxLoaderPath = requireFromTest.resolve('tsx');
const tempRoots: string[] = [];
const cliTestTimeoutMs = 30_000;

type FetchImplementation = typeof globalThis.fetch;

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
}

interface MutableTraceRecord {
  [key: string]: unknown;
  spans?: MutableTraceRecord[];
}

function runGhost(cwd: string, args: readonly string[], timeout = 15_000): CliResult {
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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ghosttrace-cross-area-resilience-'));
  tempRoots.push(root);
  return root;
}

async function readJsonFile(path: string): Promise<MutableTraceRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as MutableTraceRecord;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deserializeTraceValue<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
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

function recordedFetch(label: string): FetchImplementation {
  return async (input: RequestInfo | URL) =>
    new Response(JSON.stringify({ label, url: String(input) }), {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromiseCallback) => {
    resolvePromise = resolvePromiseCallback;
  });

  return {
    promise,
    resolve: () => resolvePromise?.()
  };
}

function httpSpan(trace: Trace, url: string): Span | undefined {
  return trace.spans.find(
    (span) =>
      span.type === SpanType.Http &&
      isRecord(span.input) &&
      span.input.url === url
  );
}

describe('cross-area resilience and configuration flows', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reports specific validation failures for truncated JSON, missing fields, and bad checksums', async () => {
    const root = await tempRoot();
    const validTrace = await ghost.record('corruption-source', () => 'ok', {
      interceptors: []
    });
    const validPath = await validTrace.save(join(root, 'valid.ghosttrace.json'));
    const validResult = await ghost.validateTrace(validPath);

    expect(validResult).toMatchObject({ valid: true, errors: [] });

    const truncatedPath = join(root, 'truncated.ghosttrace.json');
    await writeFile(truncatedPath, '{"id":"trace_truncated"', 'utf8');
    const truncatedResult = await ghost.validateTrace(truncatedPath);

    expect(truncatedResult.valid).toBe(false);
    expect(truncatedResult.errors).toEqual([
      expect.objectContaining({
        code: 'TRACE_JSON_PARSE_ERROR',
        message: expect.stringContaining('parse')
      })
    ]);

    const missingFieldPath = join(root, 'missing-field.ghosttrace.json');
    const missingFieldTrace = await readJsonFile(validPath);
    missingFieldTrace.version = '1.0.0';
    delete missingFieldTrace.checksum;
    delete missingFieldTrace.spans?.[0]?.output;
    await writeFile(missingFieldPath, JSON.stringify(missingFieldTrace), 'utf8');
    const missingFieldResult = await ghost.validateTrace(missingFieldPath);

    expect(missingFieldResult.valid).toBe(false);
    expect(missingFieldResult.errors).toEqual([
      expect.objectContaining({
        code: 'TRACE_REQUIRED_FIELD_MISSING',
        path: '$.spans[0].output',
        message: expect.stringContaining('required')
      })
    ]);

    const badChecksumPath = join(root, 'bad-checksum.ghosttrace.json');
    const badChecksumTrace = await readJsonFile(validPath);
    badChecksumTrace.checksum = `sha256:${'0'.repeat(64)}`;
    await writeFile(badChecksumPath, JSON.stringify(badChecksumTrace), 'utf8');
    const badChecksumResult = await ghost.validateTrace(badChecksumPath);

    expect(badChecksumResult.valid).toBe(false);
    expect(badChecksumResult.errors).toEqual([
      expect.objectContaining({
        code: 'TRACE_CHECKSUM_MISMATCH',
        path: '$.checksum',
        message: expect.stringContaining('checksum')
      })
    ]);
    await expect(ghost.replay(badChecksumPath, () => 'should not run')).rejects.toMatchObject({
      name: TraceValidationError.name,
      message: expect.stringContaining('checksum')
    });
  });

  it('runs 10 parallel replays independently with unique trace outputs and no cross-contamination', async () => {
    const traces: Trace[] = [];

    for (const index of Array.from({ length: 10 }, (_unused, itemIndex) => itemIndex)) {
      traces.push(
        await withFetch(recordedFetch(`trace-${index}`), () =>
          ghost.record(
            `parallel-replay-${index}`,
            async () => {
              const response = await fetch(`https://api.example.test/replay/${index}`);
              return response.json() as Promise<Readonly<Record<string, unknown>>>;
            },
            { interceptors: ['http'] }
          )
        )
      );
    }

    const liveFetch = vi.fn(async () => {
      throw new Error('parallel replay should not call live fetch');
    });
    vi.stubGlobal('fetch', liveFetch);

    const results = await Promise.all(
      traces.map((trace, index) =>
        ghost.replay(trace, async () => {
          const response = await fetch(`https://api.example.test/replay/${index}`);
          return response.json() as Promise<Readonly<Record<string, unknown>>>;
        })
      )
    );

    expect(results.map((result) => result.output.label)).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `trace-${index}`)
    );
    expect(results.map((result) => result.spansMatched[0]?.span.id)).toEqual(
      traces.map((trace) => trace.spans.find((span) => span.type === SpanType.Http)?.id)
    );
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it('composes global config defaults with per-test overrides', async () => {
    const envKey = 'GHOSTTRACE_CONFIG_INHERITANCE_TEST';
    function configuredFunction(): string {
      return 'wrapped-output';
    }
    const wrappedConfiguredFunction = wrap(configuredFunction);
    const tracer = ghost.createTracer({
      interceptors: ['function'],
      metadata: {
        inherited: true,
        level: 'global'
      }
    });

    const inheritedTrace = await tracer.record('config-inherited', () => wrappedConfiguredFunction(), {
      metadata: {
        level: 'test',
        localOverride: true
      }
    });

    expect(inheritedTrace.metadata).toMatchObject({
      inherited: true,
      level: 'test',
      localOverride: true
    });
    expect(inheritedTrace.spans.some((span) => span.name === 'configuredFunction' && span.parentId !== null)).toBe(true);

    process.env[envKey] = 'recorded-env';
    const overriddenTrace = await tracer.record(
      'config-overridden',
      () => {
        wrappedConfiguredFunction();
        return process.env[envKey];
      },
      {
        interceptors: ['env'],
        metadata: {
          localOverride: 'interceptors'
        }
      }
    );

    expect(overriddenTrace.metadata).toMatchObject({
      inherited: true,
      level: 'global',
      localOverride: 'interceptors'
    });
    expect(overriddenTrace.spans.some((span) => span.type === SpanType.Env)).toBe(true);
    expect(overriddenTrace.spans.some((span) => span.name === 'configuredFunction' && span.parentId !== null)).toBe(false);
    delete process.env[envKey];
  });

  it('discovers project config for CLI commands, supports --config override, and uses defaults when absent', async () => {
    const root = await tempRoot();
    const nestedProject = join(root, 'packages', 'app');
    const configImportPath = join(projectRoot, 'src/index.ts').replaceAll('\\', '/');
    await mkdir(nestedProject, { recursive: true });
    await writeFile(
      join(root, 'ghosttrace.config.ts'),
      [
        `import { defineConfig } from ${JSON.stringify(configImportPath)};`,
        'export default defineConfig({',
        "  traceDir: 'parent-traces',",
        "  interceptors: ['function'],",
        "  metadata: { configuredFrom: 'parent' }",
        '});'
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      join(root, 'override.config.ts'),
      [
        `import { defineConfig } from ${JSON.stringify(configImportPath)};`,
        'export default defineConfig({',
        "  traceDir: 'override-traces',",
        "  interceptors: ['function'],",
        "  metadata: { configuredFrom: 'override' }",
        '});'
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      join(nestedProject, 'flow.ts'),
      'export function run(id: number) { return { id, source: "cli-config" }; }',
      'utf8'
    );

    const autoDiscovered = runGhost(nestedProject, ['record', './flow.ts', 'run', '--args', '[3]'], cliTestTimeoutMs);

    expect(autoDiscovered.status).toBe(0);
    const parentTraceDir = join(root, 'parent-traces');
    const parentTraceFiles = readdirSync(parentTraceDir).filter((fileName) => fileName.endsWith('.ghosttrace.json'));
    expect(parentTraceFiles).toHaveLength(1);
    const parentTrace = await readJsonFile(join(parentTraceDir, parentTraceFiles[0] ?? ''));
    expect(parentTrace.metadata).toMatchObject({ configuredFrom: 'parent' });

    const overridden = runGhost(
      nestedProject,
      ['record', './flow.ts', 'run', '--args', '[4]', '--config', '../../override.config.ts'],
      cliTestTimeoutMs
    );

    expect(overridden.status).toBe(0);
    const overrideTraceDir = join(root, 'override-traces');
    const overrideTraceFiles = readdirSync(overrideTraceDir).filter((fileName) => fileName.endsWith('.ghosttrace.json'));
    expect(overrideTraceFiles).toHaveLength(1);
    const overrideTrace = await readJsonFile(join(overrideTraceDir, overrideTraceFiles[0] ?? ''));
    expect(overrideTrace.metadata).toMatchObject({ configuredFrom: 'override' });

    const noConfigRoot = await tempRoot();
    await writeFile(join(noConfigRoot, 'flow.ts'), 'export function run() { return "default-config"; }', 'utf8');
    const missingConfigDefaults = runGhost(noConfigRoot, ['record', './flow.ts', 'run', '--interceptors', 'function'], cliTestTimeoutMs);

    expect(missingConfigDefaults.status).toBe(0);
    expect(existsSync(join(noConfigRoot, '__ghosttraces__'))).toBe(true);
    expect(readdirSync(join(noConfigRoot, '__ghosttraces__')).filter((fileName) => fileName.endsWith('.ghosttrace.json'))).toHaveLength(1);
  }, cliTestTimeoutMs);

  it('loads portable traces with normalized paths, UTC timestamps, and CRLF line endings', async () => {
    const root = await tempRoot();
    const windowsPath = 'C:\\ghosttrace\\portable\\profile.txt';
    const posixPath = '/ghosttrace/portable/profile.txt';
    const portableTrace = withTraceChecksum({
      id: 'trace_portable',
      name: 'portable trace',
      version: '3.0.0',
      startTime: 0,
      endTime: 1,
      duration: 1,
      spans: [
        {
          id: 'span_0001',
          parentId: null,
          type: SpanType.Fs,
          name: 'fs.readFileSync',
          startTime: 0,
          endTime: 1,
          duration: 1,
          input: {
            operation: 'readFile',
            api: 'sync',
            path: windowsPath,
            normalizedPath: posixPath,
            options: {
              encoding: 'utf8'
            }
          },
          output: {
            result: {
              kind: 'string',
              byteLength: 'portable-content'.length,
              encoding: 'utf8',
              content: 'portable-content'
            }
          },
          children: [],
          error: null,
          metadata: {
            operation: 'readFile',
            api: 'sync',
            path: windowsPath,
            normalizedPath: posixPath
          }
        }
      ],
      metadata: {
        platform: 'win32',
        recordedAt: '2026-05-06T00:00:00.000Z'
      }
    } satisfies Trace);
    const tracePath = join(root, 'portable.ghosttrace.json');
    await writeFile(tracePath, JSON.stringify(portableTrace, null, 2).replaceAll('\n', '\r\n'), 'utf8');

    const loaded = await ghost.loadTrace(tracePath);
    expect(loaded.metadata.recordedAt).toBe('2026-05-06T00:00:00.000Z');
    const validation = await ghost.validateTrace(tracePath);
    expect(validation).toMatchObject({ valid: true, errors: [] });

    const replayed = await ghost.replay(loaded, () => fs.readFileSync(posixPath, 'utf8'));

    expect(replayed.output).toBe('portable-content');
    expect(replayed.spansMatched).toHaveLength(1);
    expect(replayed.spansMatched[0]?.span.input).toMatchObject({
      normalizedPath: posixPath
    });
  });

  it('isolates simultaneous record and replay sessions sharing global interceptors', async () => {
    const replayUrl = 'https://api.example.test/mixed/replay';
    const recordUrl = 'https://api.example.test/mixed/record';
    const replayTrace = await withFetch(recordedFetch('replay-baseline'), () =>
      ghost.record(
        'mixed-record-replay-baseline',
        async () => {
          const response = await fetch(replayUrl);
          return response.json() as Promise<Readonly<Record<string, unknown>>>;
        },
        { interceptors: ['http'] }
      )
    );
    const replayReady = deferred();
    const releaseReplay = deferred();
    const liveFetch = vi.fn(async (input: RequestInfo | URL) =>
      new Response(JSON.stringify({ label: 'live-record', url: String(input) }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      })
    );
    vi.stubGlobal('fetch', liveFetch);

    const replayPromise = ghost.replay(replayTrace, async () => {
      replayReady.resolve();
      await releaseReplay.promise;
      const response = await fetch(replayUrl);
      return response.json() as Promise<Readonly<Record<string, unknown>>>;
    });

    await replayReady.promise;
    const recordPromise = ghost.record(
      'mixed-record-live',
      async () => {
        const response = await fetch(recordUrl);
        return response.json() as Promise<Readonly<Record<string, unknown>>>;
      },
      { interceptors: ['http'] }
    );

    releaseReplay.resolve();
    const [recordedTrace, replayed] = await Promise.all([recordPromise, replayPromise]);
    const recordedHttpSpan = httpSpan(recordedTrace, recordUrl);

    expect(replayed.output).toMatchObject({ label: 'replay-baseline', url: replayUrl });
    expect(deserializeTraceValue<Readonly<Record<string, unknown>>>(recordedTrace.spans[0]?.output)).toMatchObject({
      label: 'live-record',
      url: recordUrl
    });
    expect(recordedHttpSpan).toBeDefined();
    expect(recordedHttpSpan?.output).toMatchObject({
      body: expect.stringContaining('live-record')
    });
    expect(liveFetch).toHaveBeenCalledTimes(1);
    expect(liveFetch).toHaveBeenCalledWith(recordUrl, undefined);
  });
});
