import * as fsPromises from 'node:fs/promises';
import { createTraceContext, runWithTraceContext } from '../core/context.js';
import { ReplayMismatchError, TraceValidationError } from '../core/errors.js';
import {
  SpanType,
  type ReplayOptions,
  type ReplayResult,
  type Span,
  type Trace,
  type TraceableFunction
} from '../core/types.js';
import {
  dbInterceptor,
  envInterceptor,
  fsInterceptor,
  httpInterceptor,
  performanceInterceptor,
  queueInterceptor,
  randomInterceptor,
  timerInterceptor,
  type Interceptor,
  type Teardown
} from '../interceptors/index.js';
import { createReplayStore } from './store.js';

interface ReplayInterceptorEntry {
  readonly type: SpanType;
  readonly interceptor: Interceptor;
}

const replayInterceptors: readonly ReplayInterceptorEntry[] = [
  { type: SpanType.Timer, interceptor: timerInterceptor },
  { type: SpanType.Random, interceptor: randomInterceptor },
  { type: SpanType.Env, interceptor: envInterceptor },
  { type: SpanType.Http, interceptor: httpInterceptor },
  { type: SpanType.Fs, interceptor: fsInterceptor },
  { type: SpanType.Db, interceptor: dbInterceptor },
  { type: SpanType.Queue, interceptor: queueInterceptor },
  { type: SpanType.Performance, interceptor: performanceInterceptor }
];

function monotonicNow(): number {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

function traceShapeError(filePath: string, reason: string, context: Readonly<Record<string, unknown>> = {}): TraceValidationError {
  return new TraceValidationError(`Invalid replay trace file ${filePath}: ${reason}`, {
    code: 'GHOSTTRACE_REPLAY_TRACE_INVALID',
    context: {
      filePath,
      reason,
      ...context
    }
  });
}

function assertTraceShape<TSpan extends Span>(value: unknown, filePath: string): asserts value is Trace<TSpan> {
  if (!isRecord(value)) {
    throw traceShapeError(filePath, 'trace JSON must contain an object');
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw traceShapeError(filePath, 'trace.id must be a non-empty string');
  }
  if (typeof value.name !== 'string') {
    throw traceShapeError(filePath, 'trace.name must be a string');
  }
  if (typeof value.version !== 'string') {
    throw traceShapeError(filePath, 'trace.version must be a string');
  }
  if (typeof value.startTime !== 'number' || typeof value.endTime !== 'number' || typeof value.duration !== 'number') {
    throw traceShapeError(filePath, 'trace timing fields must be numbers');
  }
  if (!Array.isArray(value.spans)) {
    throw traceShapeError(filePath, 'trace.spans must be an array');
  }
  if (!isRecord(value.metadata)) {
    throw traceShapeError(filePath, 'trace.metadata must be an object');
  }

  for (const [index, span] of value.spans.entries()) {
    if (!isRecord(span)) {
      throw traceShapeError(filePath, 'trace.spans entries must be objects', { index });
    }
    if (typeof span.id !== 'string' || typeof span.name !== 'string' || typeof span.type !== 'string') {
      throw traceShapeError(filePath, 'trace span id, name, and type must be strings', { index });
    }
    if (
      typeof span.startTime !== 'number' ||
      typeof span.endTime !== 'number' ||
      typeof span.duration !== 'number'
    ) {
      throw traceShapeError(filePath, 'trace span timing fields must be numbers', { index });
    }
    if (!Array.isArray(span.children)) {
      throw traceShapeError(filePath, 'trace span children must be an array', { index });
    }
    if (!isRecord(span.metadata)) {
      throw traceShapeError(filePath, 'trace span metadata must be an object', { index });
    }
  }
}

async function loadReplayTrace<TSpan extends Span>(filePath: string): Promise<Trace<TSpan>> {
  let text: string;

  try {
    text = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new TraceValidationError(`Replay trace file not found: ${filePath}`, {
        code: 'GHOSTTRACE_REPLAY_TRACE_NOT_FOUND',
        context: { filePath },
        cause: error
      });
    }

    throw new TraceValidationError(`Unable to read replay trace file: ${filePath}`, {
      code: 'GHOSTTRACE_REPLAY_TRACE_READ_ERROR',
      context: {
        filePath,
        reason: error instanceof Error ? error.message : String(error)
      },
      cause: error
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TraceValidationError(`Unable to parse replay trace file ${filePath} as JSON`, {
      code: 'GHOSTTRACE_REPLAY_TRACE_PARSE_ERROR',
      context: {
        filePath,
        reason: error instanceof Error ? error.message : String(error)
      },
      cause: error
    });
  }

  assertTraceShape<TSpan>(parsed, filePath);
  return parsed;
}

function shouldInstallReplayInterceptor(type: SpanType, options: ReplayOptions): boolean {
  if (options.mode !== 'partial') {
    return true;
  }

  return (options.replayTypes ?? []).includes(type);
}

function installReplayInterceptors(options: ReplayOptions): readonly Teardown[] {
  const teardowns: Teardown[] = [];

  for (const entry of replayInterceptors) {
    if (!shouldInstallReplayInterceptor(entry.type, options) || !entry.interceptor.isAvailable()) {
      continue;
    }

    teardowns.push(entry.interceptor.install({ addSpan: () => undefined }));
  }

  return teardowns;
}

function teardownReplayInterceptors(teardowns: readonly Teardown[]): void {
  for (const teardown of [...teardowns].reverse()) {
    teardown();
  }
}

function summarizeUnmatchedSpan(span: Span): Record<string, string> {
  return {
    id: span.id,
    type: span.type,
    name: span.name
  };
}

/** Replays deterministic side-effect spans against a trace object. */
export async function replay<TOutput, TSpan extends Span = Span>(
  traceInput: Trace<TSpan> | string,
  fn: TraceableFunction<TOutput>,
  options: ReplayOptions = {}
): Promise<ReplayResult<Awaited<TOutput>, TSpan>> {
  const trace = typeof traceInput === 'string' ? await loadReplayTrace<TSpan>(traceInput) : traceInput;

  const replayStore = createReplayStore(trace, options);
  const context = createTraceContext({
    traceId: trace.id,
    mode: 'replay',
    metadata: trace.metadata,
    replayStore
  });
  const startedAt = monotonicNow();
  let output: Awaited<TOutput>;

  await runWithTraceContext(context, async () => {
    const teardowns = installReplayInterceptors(options);

    try {
      output = await fn();
      if (replayStore.mode === 'strict') {
        const unmatchedSpans = replayStore.unmatchedSpans();
        if (unmatchedSpans.length > 0) {
          throw new ReplayMismatchError(
            `Strict replay did not consume ${unmatchedSpans.length} recorded replay span${unmatchedSpans.length === 1 ? '' : 's'}`,
            {
              traceId: trace.id,
              context: {
                unmatchedCount: unmatchedSpans.length,
                unmatchedSpans: unmatchedSpans.map(summarizeUnmatchedSpan)
              }
            }
          );
        }
      }
    } finally {
      teardownReplayInterceptors(teardowns);
    }
  });

  return {
    output: output!,
    spansMatched: replayStore.matchedSpans(),
    originalDuration: trace.duration,
    replayDuration: monotonicNow() - startedAt
  };
}
