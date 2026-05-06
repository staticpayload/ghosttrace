import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { TestAPI } from 'vitest';
import type { RecordOptions, ReplayOptions, Span, TraceableFunction } from '../core/types.js';
import {
  createFrameworkRecordReplayContext,
  type GhostFrameworkRecordReplayContext,
  type GhostFrameworkUpdate
} from './shared.js';

const requireFromIntegration = createRequire(import.meta.url);

let cachedBaseTest: TestAPI | undefined;

/** Options accepted by the Vitest integration entry point. */
export interface GhostVitestOptions {
  /** Directory containing trace baselines. */
  readonly traceDir?: string;
  /** Interceptors to enable while recording. */
  readonly interceptors?: RecordOptions['interceptors'];
}

/** Function used to force a baseline update immediately or for the next recorded flow. */
export type GhostVitestUpdate = GhostFrameworkUpdate;

/** Ghost fixture surface provided to Vitest tests. */
export interface GhostVitestContext {
  /** Trace file path associated with the current test. */
  readonly traceFile: string;
  /** Spans collected or replayed for the current test. */
  readonly spans: readonly Span[];
  /** Records the current test flow. */
  readonly record: <TOutput>(fn: TraceableFunction<TOutput>, options?: ReplayOptions) => Promise<Awaited<TOutput>>;
  /** Replays the current test flow. */
  readonly replay: <TOutput>(fn: TraceableFunction<TOutput>, options?: ReplayOptions) => Promise<Awaited<TOutput>>;
  /** Updates the stored baseline trace. */
  readonly update: GhostVitestUpdate;
}

function isVitestTestApi(value: unknown): value is TestAPI {
  return typeof value === 'function' && typeof (value as { readonly extend?: unknown }).extend === 'function';
}

function loadVitestTestApi(): TestAPI {
  if (cachedBaseTest !== undefined) {
    return cachedBaseTest;
  }

  const packageJsonPath = requireFromIntegration.resolve('vitest/package.json');
  const vitestEntryPath = join(dirname(packageJsonPath), 'dist/index.js');
  const vitestModule = requireFromIntegration(vitestEntryPath) as { readonly test?: unknown };
  if (!isVitestTestApi(vitestModule.test)) {
    throw new Error('GhostTrace could not load the Vitest test API.');
  }

  cachedBaseTest = vitestModule.test;
  return cachedBaseTest;
}

function createGhostContext(taskName: string, options: GhostVitestOptions): GhostVitestContext {
  const lifecycle: GhostFrameworkRecordReplayContext = createFrameworkRecordReplayContext({
    framework: 'vitest',
    fallbackTraceName: 'ghosttrace-vitest-test',
    testName: taskName,
    traceOptions: options
  });

  return {
    traceFile: lifecycle.traceFile,
    get spans(): readonly Span[] {
      return lifecycle.spans;
    },
    record: <TOutput>(fn: TraceableFunction<TOutput>, replayOptions: ReplayOptions = {}) =>
      lifecycle.record(fn, replayOptions),
    replay: <TOutput>(fn: TraceableFunction<TOutput>, replayOptions: ReplayOptions = {}) =>
      lifecycle.replay(fn, replayOptions),
    update: lifecycle.update
  };
}

/** Creates a Vitest test fixture with GhostTrace record/replay helpers. */
export function ghostFixture(options: GhostVitestOptions = {}): TestAPI<{ ghost: GhostVitestContext }> {
  return loadVitestTestApi().extend<{ ghost: GhostVitestContext }>({
    ghost: async ({ task }, use): Promise<void> => {
      await use(createGhostContext(task.fullTestName ?? task.fullName ?? task.name, options));
    }
  });
}
