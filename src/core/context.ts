import { AsyncLocalStorage } from 'node:async_hooks';
import { createVirtualClock, type VirtualClock } from './clock.js';
import { RecordingError } from './errors.js';
import { createIdGenerator, type DeterministicIdGenerator } from './id.js';
import type { Span, TraceMetadata } from './types.js';

/** Execution mode associated with an active GhostTrace context. */
export type TraceContextMode = 'record' | 'replay';

/** Options for creating an AsyncLocalStorage-backed trace context. */
export interface CreateTraceContextOptions {
  /** Trace identifier for the active recording or replay session. */
  readonly traceId: string;
  /** Active execution mode. Defaults to "record". */
  readonly mode?: TraceContextMode;
  /** Current parent span, or null for root operations. */
  readonly currentSpan?: Span | null;
  /** Deterministic trace-relative clock. */
  readonly clock?: VirtualClock;
  /** Deterministic span ID generator scoped to this trace. */
  readonly idGenerator?: DeterministicIdGenerator;
  /** Deterministic global sequence generator scoped to this trace. */
  readonly sequenceGenerator?: DeterministicIdGenerator;
  /** Context metadata copied from recording options. */
  readonly metadata?: TraceMetadata;
  /** Replay-store placeholder for future replay-engine features. */
  readonly replayStore?: unknown;
}

/** Async execution context shared by record/replay components and interceptors. */
export interface TraceContext {
  /** Trace identifier for the active recording or replay session. */
  readonly traceId: string;
  /** Active execution mode. */
  readonly mode: TraceContextMode;
  /** Current parent span, or null for root operations. */
  readonly currentSpan: Span | null;
  /** Deterministic trace-relative clock. */
  readonly clock: VirtualClock;
  /** Deterministic span ID generator scoped to this trace. */
  readonly idGenerator: DeterministicIdGenerator;
  /** Deterministic global sequence generator scoped to this trace. */
  readonly sequenceGenerator: DeterministicIdGenerator;
  /** Context metadata copied from recording options. */
  readonly metadata: TraceMetadata;
  /** Replay-store placeholder for future replay-engine features. */
  readonly replayStore?: unknown;
}

const traceContextStorage = new AsyncLocalStorage<TraceContext>();

function assertTraceId(traceId: string): void {
  if (traceId.length === 0) {
    throw new RecordingError('Trace context requires a non-empty traceId', {
      code: 'GHOSTTRACE_CONTEXT_INVALID',
      context: { traceId }
    });
  }
}

/** Creates a trace context with isolated deterministic utilities for one trace. */
export function createTraceContext(options: CreateTraceContextOptions): TraceContext {
  assertTraceId(options.traceId);

  const context: TraceContext = {
    traceId: options.traceId,
    mode: options.mode ?? 'record',
    currentSpan: options.currentSpan ?? null,
    clock: options.clock ?? createVirtualClock(),
    idGenerator: options.idGenerator ?? createIdGenerator({ prefix: 'span' }),
    sequenceGenerator: options.sequenceGenerator ?? createIdGenerator({
      prefix: 'sequence',
      start: 0,
      width: 4
    }),
    metadata: options.metadata === undefined ? {} : { ...options.metadata }
  };

  if (options.replayStore !== undefined) {
    return {
      ...context,
      replayStore: options.replayStore
    };
  }

  return context;
}

/** Runs a callback inside the supplied trace context, propagating through async boundaries. */
export function runWithTraceContext<TValue>(context: TraceContext, callback: () => TValue): TValue {
  return traceContextStorage.run(context, callback);
}

/** Returns the active trace context for the current async execution, if one exists. */
export function getTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

/** Returns the active trace context or throws a RecordingError when none is active. */
export function requireTraceContext(): TraceContext {
  const context = getTraceContext();

  if (context === undefined) {
    throw new RecordingError('No active GhostTrace context is available', {
      code: 'GHOSTTRACE_CONTEXT_MISSING'
    });
  }

  return context;
}

/** Runs a callback with the active trace context updated to use the supplied current span. */
export function runWithSpanContext<TValue>(span: Span, callback: () => TValue): TValue {
  const context = requireTraceContext();
  return runWithTraceContext(
    {
      ...context,
      currentSpan: span
    },
    callback
  );
}
