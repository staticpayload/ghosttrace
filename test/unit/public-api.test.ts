import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SpanType,
  TRACE_FORMAT_VERSION,
  TraceValidationError,
  createTrace,
  createTracer,
  defineConfig,
  ghost,
  loadTrace,
  withTraceChecksum,
  type GhostTraceConfig,
  type GhostTracePlugin,
  type Interceptor,
  type Span,
  type Trace
} from '../../src/index.js';

const tempDirs: string[] = [];

function span(id: string, fields: Partial<Span> = {}): Span {
  return {
    id,
    parentId: null,
    type: SpanType.Function,
    name: `operation-${id}`,
    startTime: 0,
    endTime: 1,
    duration: 1,
    input: [],
    output: { ok: true },
    children: [],
    error: null,
    metadata: {},
    ...fields
  };
}

function trace(fields: Partial<Trace> = {}): Trace {
  return {
    id: 'trace_public_api',
    name: 'public-api',
    version: TRACE_FORMAT_VERSION,
    startTime: 0,
    endTime: 1,
    duration: 1,
    spans: [span('span_0001')],
    metadata: {},
    ...fields
  };
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghosttrace-public-api-'));
  tempDirs.push(directory);
  return directory;
}

describe('public API foundation', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('exports a minimal trace factory and SpanType values for consumers', () => {
    const trace = createTrace({ id: 'trace_1', name: 'foundation', spans: [] });

    expect(trace.id).toBe('trace_1');
    expect(trace.name).toBe('foundation');
    expect(trace.version).toBe(TRACE_FORMAT_VERSION);
    expect(trace.spans).toEqual([]);
    expect(SpanType.Function).toBe('function');
  });

  it('exposes a typed ghost namespace and defineConfig helper without import side effects', () => {
    const config = defineConfig({ traceDir: '__ghosttraces__', interceptors: ['function'] });

    expect(config.traceDir).toBe('__ghosttraces__');
    expect(config.interceptors).toEqual(['function']);
    expect(ghost.defineConfig(config)).toEqual(config);
  });

  it('loadTrace reads, validates, checksum-checks, and migrates trace files', async () => {
    const directory = await createTempDir();
    const validPath = join(directory, 'valid.ghosttrace.json');
    const migratedPath = join(directory, 'migrated.ghosttrace.json');
    const tamperedPath = join(directory, 'tampered.ghosttrace.json');

    await writeFile(validPath, JSON.stringify(withTraceChecksum(trace())), 'utf8');
    await writeFile(migratedPath, JSON.stringify(trace({ version: '1.0.0' })), 'utf8');
    await writeFile(
      tamperedPath,
      JSON.stringify({
        ...withTraceChecksum(trace()),
        name: 'tampered-after-checksum'
      }),
      'utf8'
    );

    await expect(loadTrace(validPath)).resolves.toMatchObject({
      id: 'trace_public_api',
      version: TRACE_FORMAT_VERSION,
      checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    await expect(ghost.loadTrace(migratedPath)).resolves.toMatchObject({
      version: TRACE_FORMAT_VERSION,
      checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    await expect(loadTrace(tamperedPath)).rejects.toThrow(/checksum/i);
  });

  it('loadTrace reports missing files and corrupted JSON with descriptive GhostTrace errors', async () => {
    const directory = await createTempDir();
    const corruptedPath = join(directory, 'corrupted.ghosttrace.json');
    await writeFile(corruptedPath, '{ not-json', 'utf8');

    await expect(loadTrace(join(directory, 'missing.ghosttrace.json'))).rejects.toThrow(/not found/i);
    await expect(loadTrace(corruptedPath)).rejects.toBeInstanceOf(TraceValidationError);
    await expect(loadTrace(corruptedPath)).rejects.toThrow(/parse/i);
  });

  it('createTracer returns isolated API instances with independent record configuration', async () => {
    function addOne(value: number): number {
      return value + 1;
    }

    const wrappedAddOne = ghost.wrap(addOne);
    const functionTracer = createTracer({
      metadata: { suite: 'function-tracer' },
      interceptors: ['function']
    });
    const emptyTracer = createTracer({
      metadata: { suite: 'empty-tracer' },
      interceptors: []
    });

    const functionTrace = await functionTracer.record('function-trace', () => wrappedAddOne(1));
    const emptyTrace = await emptyTracer.record('empty-trace', () => wrappedAddOne(2));

    expect(functionTrace.metadata.suite).toBe('function-tracer');
    expect(emptyTrace.metadata.suite).toBe('empty-tracer');
    expect(functionTrace.spans.some((recordedSpan) => recordedSpan.name === 'addOne')).toBe(true);
    expect(emptyTrace.spans.some((recordedSpan) => recordedSpan.name === 'addOne')).toBe(false);
    await expect(functionTracer.replay(functionTrace, () => 2)).resolves.toMatchObject({ output: 2 });
    await expect(emptyTracer.replay(emptyTrace, () => 3)).resolves.toMatchObject({ output: 3 });
  });

  it('defineConfig validates configuration shape and reports invalid values at runtime', () => {
    const customInterceptor: Interceptor = {
      name: 'custom-effect',
      isAvailable: () => true,
      install: () => () => undefined
    };
    const plugin: GhostTracePlugin = {
      name: 'custom-interceptor-plugin',
      version: '1.0.0',
      interceptors: [customInterceptor]
    };

    expect(defineConfig({
      traceDir: '__ghosttraces__',
      interceptors: ['function', 'custom-effect'],
      plugins: [plugin],
      redaction: {
        paths: [{ path: '$.secret' }],
        patterns: [{ pattern: 'token-[a-z]+', label: 'TOKEN' }]
      },
      metadata: { framework: 'vitest' }
    })).toMatchObject({
      traceDir: '__ghosttraces__',
      interceptors: ['function', 'custom-effect']
    });

    expect(() => defineConfig({ traceDir: 42 } as unknown as GhostTraceConfig)).toThrow(/traceDir.*string/i);
    expect(() => defineConfig({ interceptors: 'function' } as unknown as GhostTraceConfig)).toThrow(/interceptors.*array/i);
    expect(() => defineConfig({ interceptors: ['not-registered'] })).toThrow(/interceptor.*not-registered/i);
    expect(() => defineConfig({ unknown: true } as unknown as GhostTraceConfig)).toThrow(/unknown.*unknown/i);
    expect(() => defineConfig({
      redaction: { paths: [{ path: 'secret' }] }
    })).toThrow(/redaction path/i);
    expect(() => defineConfig({
      redaction: { patterns: [{ pattern: '[', label: 'BROKEN' }] }
    })).toThrow(/regex/i);
  });

  it('pre-wrapped functions and modules work outside sessions and capture after recording starts', async () => {
    function multiply(left: number, right: number): number {
      return left * right;
    }

    const wrappedMultiply = ghost.wrap(multiply);
    const wrappedModule = ghost.wrapModule({
      offset: 1,
      add(value: number): number {
        return value + this.offset;
      }
    });

    expect(wrappedMultiply(2, 3)).toBe(6);
    expect(wrappedModule.add(4)).toBe(5);

    const recorded = await ghost.record(
      'prewrapped-functions',
      () => [wrappedMultiply(3, 4), wrappedModule.add(9)],
      { interceptors: ['function'] }
    );

    expect(wrappedMultiply(4, 5)).toBe(20);
    expect(wrappedModule.add(10)).toBe(11);
    expect(recorded.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: SpanType.Function,
          name: 'multiply',
          input: [3, 4],
          output: 12
        }),
        expect.objectContaining({
          type: SpanType.Function,
          name: 'add',
          input: [9],
          output: 10
        })
      ])
    );
  });
});
