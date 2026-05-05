import { createTraceContext, runWithTraceContext } from '../core/context.js';
import { GhostTraceError } from '../core/errors.js';
import {
  SpanType,
  type ReplayOptions,
  type ReplayResult,
  type Span,
  type Trace,
  type TraceableFunction
} from '../core/types.js';
import {
  envInterceptor,
  fsInterceptor,
  performanceInterceptor,
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
  { type: SpanType.Fs, interceptor: fsInterceptor },
  { type: SpanType.Performance, interceptor: performanceInterceptor }
];

function notImplemented(featureName: string): GhostTraceError {
  return new GhostTraceError(`${featureName} is not implemented for replay from file paths yet`, {
    code: 'GHOSTTRACE_NOT_IMPLEMENTED',
    context: { featureName }
  });
}

function monotonicNow(): number {
  return typeof performance === 'object' && typeof performance.now === 'function' ? performance.now() : Date.now();
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

/** Replays deterministic timer, random, env, and filesystem spans against a trace object. */
export async function replay<TOutput, TSpan extends Span = Span>(
  trace: Trace<TSpan> | string,
  fn: TraceableFunction<TOutput>,
  options: ReplayOptions = {}
): Promise<ReplayResult<Awaited<TOutput>, TSpan>> {
  if (typeof trace === 'string') {
    throw notImplemented('replay');
  }

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
