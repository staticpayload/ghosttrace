import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ReplayMismatchError } from '../core/errors.js';
import { sanitizeTraceNameForFilename } from '../core/persistence.js';
import { deserialize, serialize, stringifySerialized, type SerializedJsonValue } from '../core/serializer.js';
import { SpanType, type RecordOptions, type ReplayOptions, type Span, type Trace, type TraceableFunction } from '../core/types.js';
import { record as recordTrace } from '../recorder/index.js';
import { replay as replayTrace } from '../replay/index.js';
import { validateTrace, type TraceValidationResult } from '../validation/index.js';

const DEFAULT_TRACE_DIR = '__ghosttraces__';
const TRACE_FILE_SUFFIX = '.ghosttrace.json';

/** Shared options for framework integrations that persist trace baselines. */
export interface GhostFrameworkTraceOptions {
  /** Directory containing trace baselines. */
  readonly traceDir?: string;
  /** Interceptors to enable while recording. */
  readonly interceptors?: RecordOptions['interceptors'];
}

/** Function used to force a baseline update immediately or for the next recorded flow. */
export interface GhostFrameworkUpdate {
  /** Marks the next record/replay call as a baseline update. */
  (): Promise<void>;
  /** Re-records and overwrites the current baseline with the supplied flow. */
  <TOutput>(fn: TraceableFunction<TOutput>): Promise<Awaited<TOutput>>;
}

/** Shared record/replay lifecycle used by test framework integrations. */
export interface GhostFrameworkRecordReplayContext {
  /** Trace file path associated with the current test. */
  readonly traceFile: string;
  /** Spans collected or replayed for the current test. */
  readonly spans: readonly Span[];
  /** Records or replays the current test flow depending on baseline state. */
  readonly record: <TOutput>(fn: TraceableFunction<TOutput>, options?: ReplayOptions) => Promise<Awaited<TOutput>>;
  /** Replays the current test flow, re-recording when the baseline is absent or invalid. */
  readonly replay: <TOutput>(fn: TraceableFunction<TOutput>, options?: ReplayOptions) => Promise<Awaited<TOutput>>;
  /** Updates the stored baseline trace. */
  readonly update: GhostFrameworkUpdate;
}

interface CreateFrameworkRecordReplayContextOptions {
  readonly framework: string;
  readonly fallbackTraceName: string;
  readonly testName: string;
  readonly traceOptions: GhostFrameworkTraceOptions;
}

interface FrameworkLifecycleState {
  spans: readonly Span[];
  updateNext: boolean;
  hasBaseline: boolean;
}

/** Resolves a framework trace directory, applying the shared GhostTrace default. */
export function normalizeTraceDirectory(traceDir: string | undefined): string {
  return resolve(traceDir ?? DEFAULT_TRACE_DIR);
}

/** Resolves an empty framework test name to a stable fallback trace name. */
export function resolveTraceName(testName: string, fallbackTraceName: string): string {
  return testName.length === 0 ? fallbackTraceName : testName;
}

/** Builds the deterministic baseline file path for a framework trace name. */
export function traceFileForName(traceDir: string, traceName: string): string {
  return join(traceDir, `${sanitizeTraceNameForFilename(traceName)}${TRACE_FILE_SUFFIX}`);
}

/** Emits the standard framework resilience warning before re-recording a baseline. */
export function warnFrameworkTraceReRecord(framework: string, traceFile: string, reason: string): void {
  console.warn(`GhostTrace ${framework} baseline ${traceFile} is ${reason}; re-recording.`);
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

function validationFailureReason(validation: TraceValidationResult): string {
  if (validation.errors.length === 0) {
    return 'unavailable';
  }

  return validation.errors.map((issue) => `${issue.code}: ${issue.message}`).join('; ');
}

async function loadBaselineTraceOrWarn(framework: string, traceFile: string): Promise<Trace | undefined> {
  const validation = await validateTrace(traceFile);
  if (validation.valid && validation.trace !== undefined) {
    return validation.trace;
  }

  warnFrameworkTraceReRecord(framework, traceFile, validationFailureReason(validation));
  return undefined;
}

function recordOptionsForFramework(
  framework: string,
  traceFile: string,
  options: GhostFrameworkTraceOptions
): RecordOptions {
  const metadata = {
    framework,
    traceFile
  };

  if (options.interceptors === undefined) {
    return { metadata };
  }

  return {
    interceptors: options.interceptors,
    metadata
  };
}

async function recordBaseline<TOutput>(
  framework: string,
  traceName: string,
  traceFile: string,
  options: GhostFrameworkTraceOptions,
  state: FrameworkLifecycleState,
  fn: TraceableFunction<TOutput>
): Promise<Awaited<TOutput>> {
  let output: Awaited<TOutput> | undefined;
  const trace = await recordTrace(
    traceName,
    async () => {
      output = await fn();
      return output;
    },
    recordOptionsForFramework(framework, traceFile, options)
  );

  state.spans = trace.spans;
  state.hasBaseline = true;
  await trace.save({ filePath: traceFile });
  throwIfRecordedRootErrored(trace, traceFile);

  return output as Awaited<TOutput>;
}

async function replayBaseline<TOutput>(
  baseline: Trace,
  traceFile: string,
  state: FrameworkLifecycleState,
  fn: TraceableFunction<TOutput>,
  options: ReplayOptions
): Promise<Awaited<TOutput>> {
  const replayed = await replayTrace(baseline, fn, options);
  state.spans = replayed.spansMatched.map((match) => match.span);
  state.hasBaseline = true;

  if (!isDeepStrictEqual(rootOutput(baseline), serialize(replayed.output))) {
    throw replayOutputMismatchError(baseline, traceFile, replayed.output);
  }

  return replayed.output;
}

/** Creates the shared record/replay lifecycle for Vitest and Jest integrations. */
export function createFrameworkRecordReplayContext(
  options: CreateFrameworkRecordReplayContextOptions
): GhostFrameworkRecordReplayContext {
  const traceName = resolveTraceName(options.testName, options.fallbackTraceName);
  const traceDir = normalizeTraceDirectory(options.traceOptions.traceDir);
  const traceFile = traceFileForName(traceDir, traceName);
  const state: FrameworkLifecycleState = {
    spans: [],
    updateNext: false,
    hasBaseline: existsSync(traceFile)
  };

  const run = async <TOutput>(
    fn: TraceableFunction<TOutput>,
    replayOptions: ReplayOptions = {}
  ): Promise<Awaited<TOutput>> => {
    if (state.updateNext) {
      state.updateNext = false;
      return recordBaseline(options.framework, traceName, traceFile, options.traceOptions, state, fn);
    }

    if (!existsSync(traceFile)) {
      if (state.hasBaseline) {
        warnFrameworkTraceReRecord(options.framework, traceFile, 'missing');
      }

      return recordBaseline(options.framework, traceName, traceFile, options.traceOptions, state, fn);
    }

    const baseline = await loadBaselineTraceOrWarn(options.framework, traceFile);
    if (baseline === undefined) {
      return recordBaseline(options.framework, traceName, traceFile, options.traceOptions, state, fn);
    }

    return replayBaseline(baseline, traceFile, state, fn, replayOptions);
  };

  const update = (async <TOutput>(fn?: TraceableFunction<TOutput>): Promise<void | Awaited<TOutput>> => {
    if (fn === undefined) {
      state.updateNext = true;
      return undefined;
    }

    state.updateNext = false;
    return recordBaseline(options.framework, traceName, traceFile, options.traceOptions, state, fn);
  }) as GhostFrameworkUpdate;

  return {
    traceFile,
    get spans(): readonly Span[] {
      return state.spans;
    },
    record: run,
    replay: run,
    update
  };
}
