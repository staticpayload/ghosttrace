import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TestAPI } from 'vitest';
import { ReplayMismatchError } from '../core/errors.js';
import { sanitizeTraceNameForFilename } from '../core/persistence.js';
import { deserialize, serialize, stringifySerialized, type SerializedJsonValue } from '../core/serializer.js';
import { SpanType, type RecordOptions, type ReplayOptions, type Span, type Trace, type TraceableFunction } from '../core/types.js';
import { record as recordTrace } from '../recorder/index.js';
import { replay as replayTrace } from '../replay/index.js';
import { validateTrace } from '../validation/index.js';

const DEFAULT_TRACE_DIR = '__ghosttraces__';
const TRACE_FILE_SUFFIX = '.ghosttrace.json';
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
export interface GhostVitestUpdate {
  /** Marks the next record/replay call as a baseline update. */
  (): Promise<void>;
  /** Re-records and overwrites the current baseline with the supplied flow. */
  <TOutput>(fn: TraceableFunction<TOutput>): Promise<Awaited<TOutput>>;
}

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

interface GhostVitestState {
  spans: readonly Span[];
  updateNext: boolean;
}

function normalizeTraceDirectory(traceDir: string | undefined): string {
  return resolve(traceDir ?? DEFAULT_TRACE_DIR);
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

function traceNameForTask(taskName: string): string {
  return taskName.length === 0 ? 'ghosttrace-vitest-test' : taskName;
}

function traceFileForTask(traceDir: string, taskName: string): string {
  return join(traceDir, `${sanitizeTraceNameForFilename(traceNameForTask(taskName))}${TRACE_FILE_SUFFIX}`);
}

function rootFunctionSpan(trace: Trace): Span | undefined {
  return trace.spans.find((span) => span.parentId === null && span.type === SpanType.Function);
}

function rootOutput(trace: Trace): unknown {
  return rootFunctionSpan(trace)?.output;
}

function throwIfRecordedRootErrored(trace: Trace, traceFile: string): void {
  const error = rootFunctionSpan(trace)?.error;
  if (error === undefined || error === null) {
    return;
  }

  throw new Error(`GhostTrace recorded flow failed while updating ${traceFile}: ${error.name}: ${error.message}`);
}

function formatUnknown(value: unknown): string {
  try {
    return stringifySerialized(serialize(value));
  } catch {
    return String(value);
  }
}

function replayOutputMismatchError(trace: Trace, traceFile: string, output: unknown): ReplayMismatchError {
  const expected = rootOutput(trace);

  return new ReplayMismatchError('GhostTrace replay output differed from recorded baseline', {
    traceId: trace.id,
    context: {
      traceFile,
      expected,
      actual: serialize(output),
      expectedJson: formatUnknown(deserialize(expected as SerializedJsonValue)),
      actualJson: formatUnknown(output)
    }
  });
}

async function loadBaselineTrace(traceFile: string): Promise<Trace> {
  const validation = await validateTrace(traceFile);
  if (validation.valid && validation.trace !== undefined) {
    return validation.trace;
  }

  throw new Error(
    `GhostTrace baseline trace is invalid: ${validation.errors.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`
  );
}

async function recordBaseline<TOutput>(
  traceName: string,
  traceFile: string,
  options: GhostVitestOptions,
  state: GhostVitestState,
  fn: TraceableFunction<TOutput>
): Promise<Awaited<TOutput>> {
  let output: Awaited<TOutput> | undefined;
  const recordOptions: RecordOptions =
    options.interceptors === undefined
      ? {
          metadata: {
            framework: 'vitest',
            traceFile
          }
        }
      : {
          interceptors: options.interceptors,
          metadata: {
            framework: 'vitest',
            traceFile
          }
        };
  const trace = await recordTrace(
    traceName,
    async () => {
      output = await fn();
      return output;
    },
    recordOptions
  );

  state.spans = trace.spans;
  await trace.save({ filePath: traceFile });
  throwIfRecordedRootErrored(trace, traceFile);

  return output as Awaited<TOutput>;
}

async function replayBaseline<TOutput>(
  traceFile: string,
  state: GhostVitestState,
  fn: TraceableFunction<TOutput>,
  options: ReplayOptions
): Promise<Awaited<TOutput>> {
  const baseline = await loadBaselineTrace(traceFile);
  const replayed = await replayTrace(baseline, fn, options);
  state.spans = replayed.spansMatched.map((match) => match.span);

  if (!isDeepStrictEqual(rootOutput(baseline), serialize(replayed.output))) {
    throw replayOutputMismatchError(baseline, traceFile, replayed.output);
  }

  return replayed.output;
}

function createGhostContext(taskName: string, options: GhostVitestOptions): GhostVitestContext {
  const traceName = traceNameForTask(taskName);
  const traceDir = normalizeTraceDirectory(options.traceDir);
  const traceFile = traceFileForTask(traceDir, traceName);
  const state: GhostVitestState = {
    spans: [],
    updateNext: false
  };

  const record = async <TOutput>(
    fn: TraceableFunction<TOutput>,
    replayOptions: ReplayOptions = {}
  ): Promise<Awaited<TOutput>> => {
    if (state.updateNext || !existsSync(traceFile)) {
      state.updateNext = false;
      return recordBaseline(traceName, traceFile, options, state, fn);
    }

    return replayBaseline(traceFile, state, fn, replayOptions);
  };

  const replay = async <TOutput>(
    fn: TraceableFunction<TOutput>,
    replayOptions: ReplayOptions = {}
  ): Promise<Awaited<TOutput>> => {
    if (state.updateNext || !existsSync(traceFile)) {
      state.updateNext = false;
      return recordBaseline(traceName, traceFile, options, state, fn);
    }

    return replayBaseline(traceFile, state, fn, replayOptions);
  };

  const update = (async <TOutput>(fn?: TraceableFunction<TOutput>): Promise<void | Awaited<TOutput>> => {
    if (fn === undefined) {
      state.updateNext = true;
      return undefined;
    }

    state.updateNext = false;
    return recordBaseline(traceName, traceFile, options, state, fn);
  }) as GhostVitestUpdate;

  return {
    traceFile,
    get spans(): readonly Span[] {
      return state.spans;
    },
    record,
    replay,
    update
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
