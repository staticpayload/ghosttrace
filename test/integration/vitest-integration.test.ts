import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SpanType, deserialize, ghost as ghostApi, type SerializedJsonValue, type Trace } from '../../src/index.js';
import { ghostFixture } from '../../src/integrations/vitest.js';

const tempRoot = mkdtempSync(join(tmpdir(), 'ghosttrace-vitest-integration-'));
const traceDir = join(tempRoot, 'custom-traces');
const ghostTest = ghostFixture({
  traceDir,
  interceptors: ['env']
});

const FIRST_RUN_ENV_KEY = 'GHOSTTRACE_VITEST_FIRST_RUN';
const REPLAY_ENV_KEY = 'GHOSTTRACE_VITEST_REPLAY';
const UPDATE_ENV_KEY = 'GHOSTTRACE_VITEST_UPDATE';

function readTrace(filePath: string): Trace {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Trace;
}

function deserializeAs<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

function rootOutput(trace: Trace): unknown {
  const rootSpan = trace.spans.find((span) => span.parentId === null && span.type === SpanType.Function);
  return rootSpan?.output;
}

describe('ghostFixture Vitest integration', () => {
  afterAll(() => {
    delete process.env[FIRST_RUN_ENV_KEY];
    delete process.env[REPLAY_ENV_KEY];
    delete process.env[UPDATE_ENV_KEY];
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns a Vitest-compatible test API', () => {
    expect(typeof ghostTest).toBe('function');
    expect(typeof ghostTest.extend).toBe('function');
  });

  ghostTest('injects a ghost fixture and records the first run to the configured trace directory', async ({ ghost }) => {
    expect(typeof ghost.record).toBe('function');
    expect(typeof ghost.replay).toBe('function');
    expect(typeof ghost.update).toBe('function');
    expect(ghost.spans).toEqual([]);
    expect(dirname(ghost.traceFile)).toBe(traceDir);
    expect(existsSync(ghost.traceFile)).toBe(false);

    process.env[FIRST_RUN_ENV_KEY] = 'recorded-first';
    const output = await ghost.record(async () => ({
      env: process.env[FIRST_RUN_ENV_KEY]
    }));

    expect(output).toEqual({ env: 'recorded-first' });
    expect(existsSync(ghost.traceFile)).toBe(true);
    expect(ghost.spans.map((span) => span.type)).toContain(SpanType.Env);

    const savedTrace = readTrace(ghost.traceFile);
    expect(savedTrace.spans.map((span) => span.type)).toContain(SpanType.Env);
  });

  ghostTest('replays an existing baseline and fails with details when output diverges', async ({ ghost }) => {
    process.env[REPLAY_ENV_KEY] = 'baseline';
    const recorded = await ghost.record(() => `value:${process.env[REPLAY_ENV_KEY]}`);
    expect(recorded).toBe('value:baseline');

    process.env[REPLAY_ENV_KEY] = 'live-changed';
    const replayed = await ghost.record(() => `value:${process.env[REPLAY_ENV_KEY]}`);
    expect(replayed).toBe('value:baseline');
    expect(ghost.spans.map((span) => span.type)).toContain(SpanType.Env);

    await expect(ghost.record(() => `drift:${process.env[REPLAY_ENV_KEY]}`)).rejects.toThrow(
      /GhostTrace replay output differed/
    );
  });

  ghostTest('updates the baseline trace and limits recorded spans to configured interceptors', async ({ ghost }) => {
    process.env[UPDATE_ENV_KEY] = 'initial';
    await ghost.record(() => {
      Math.random();
      return `before:${process.env[UPDATE_ENV_KEY]}`;
    });
    const beforeUpdate = readFileSync(ghost.traceFile, 'utf8');

    process.env[UPDATE_ENV_KEY] = 'updated';
    const updated = await ghost.update(() => {
      Math.random();
      return `after:${process.env[UPDATE_ENV_KEY]}`;
    });

    expect(updated).toBe('after:updated');
    expect(readFileSync(ghost.traceFile, 'utf8')).not.toBe(beforeUpdate);

    const savedTrace = readTrace(ghost.traceFile);
    expect(deserializeAs<string>(rootOutput(savedTrace))).toBe('after:updated');
    expect(savedTrace.spans.map((span) => span.type)).toContain(SpanType.Env);
    expect(savedTrace.spans.map((span) => span.type)).not.toContain(SpanType.Random);

    process.env[UPDATE_ENV_KEY] = 'live-again';
    await expect(ghost.record(() => `after:${process.env[UPDATE_ENV_KEY]}`)).resolves.toBe('after:updated');
  });

  ghostTest('explicit replay reads the current trace file and returns matched spans', async ({ ghost }) => {
    process.env[UPDATE_ENV_KEY] = 'explicit-baseline';
    await ghost.update(() => `explicit:${process.env[UPDATE_ENV_KEY]}`);

    process.env[UPDATE_ENV_KEY] = 'explicit-live';
    const replayed = await ghost.replay(() => `explicit:${process.env[UPDATE_ENV_KEY]}`);

    expect(replayed).toBe('explicit:explicit-baseline');
    expect(ghost.spans.map((span) => span.type)).toContain(SpanType.Env);
  });

  ghostTest('marks the next record call as an update when update is called without a function', async ({ ghost }) => {
    await ghost.record(() => 'before-marked-update');
    await ghost.update();
    await expect(ghost.record(() => 'after-marked-update')).resolves.toBe('after-marked-update');

    const savedTrace = readTrace(ghost.traceFile);
    expect(deserializeAs<string>(rootOutput(savedTrace))).toBe('after-marked-update');
  });

  ghostTest('re-records corrupted and deleted baselines with warnings instead of crashing', async ({ ghost }) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let warnings = '';

    try {
      await expect(ghost.record(() => 'vitest-initial-baseline')).resolves.toBe('vitest-initial-baseline');

      writeFileSync(ghost.traceFile, '{ this is not valid JSON', 'utf8');
      await expect(ghost.record(() => 'vitest-after-corruption')).resolves.toBe('vitest-after-corruption');

      rmSync(ghost.traceFile, { force: true });
      await expect(ghost.record(() => 'vitest-after-delete')).resolves.toBe('vitest-after-delete');
      warnings = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    } finally {
      warnSpy.mockRestore();
    }

    expect(warnings).toMatch(/re-recording/i);
  });

  it('can validate traces created by the fixture', async () => {
    const traceFiles = readdirSync(traceDir)
      .filter((fileName) => fileName.endsWith('.ghosttrace.json'))
      .map((fileName) => join(traceDir, fileName));

    expect(traceFiles.length).toBeGreaterThan(0);
    for (const traceFile of traceFiles) {
      await expect(ghostApi.validateTrace(traceFile)).resolves.toMatchObject({ valid: true, errors: [] });
    }
  });
});
