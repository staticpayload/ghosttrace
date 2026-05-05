import { ReplayExhaustedError } from '../core/errors.js';
import {
  SpanType,
  type ReplayMode,
  type ReplayOptions,
  type ReplaySpanMatch,
  type Span,
  type Trace
} from '../core/types.js';

const REPLAY_STORE_MARKER = Symbol.for('ghosttrace.replayStore');

/** Recorded span returned by a replay-store consumption. */
export interface ReplayConsumption<TSpan extends Span = Span> {
  /** Span consumed for the replayed runtime call. */
  readonly span: TSpan;
  /** Zero-based call sequence for this span type/name key. */
  readonly sequence: number;
}

/** Minimal sequential replay store used by deterministic interceptors. */
export interface ReplayStore<TSpan extends Span = Span> {
  /** Marker used to safely identify GhostTrace replay stores across modules. */
  readonly [REPLAY_STORE_MARKER]: true;
  /** Replay mode selected for this execution. */
  readonly mode: ReplayMode;
  /** Returns true when the supplied span type should be replayed. */
  readonly canReplay: (type: SpanType) => boolean;
  /** Consumes the next recorded span for a type/name pair. */
  readonly consumeSpan: (type: SpanType, name: string, input: unknown) => ReplayConsumption<TSpan> | undefined;
  /** Returns all spans matched so far in replay order. */
  readonly matchedSpans: () => readonly ReplaySpanMatch<TSpan>[];
}

function spanKey(type: SpanType, name: string): string {
  return `${type}:${name}`;
}

function replayMode(options: ReplayOptions): ReplayMode {
  return options.mode ?? 'strict';
}

function replayTypes(options: ReplayOptions, mode: ReplayMode): ReadonlySet<SpanType> | null {
  if (mode !== 'partial') {
    return null;
  }

  return new Set(options.replayTypes ?? []);
}

function indexTraceSpans<TSpan extends Span>(trace: Trace<TSpan>): Map<string, TSpan[]> {
  const spansByKey = new Map<string, TSpan[]>();

  for (const span of trace.spans) {
    const key = spanKey(span.type, span.name);
    const spans = spansByKey.get(key) ?? [];
    spans.push(span);
    spansByKey.set(key, spans);
  }

  return spansByKey;
}

/** Creates a sequential replay store over a trace's chronological top-level span list. */
export function createReplayStore<TSpan extends Span>(
  trace: Trace<TSpan>,
  options: ReplayOptions = {}
): ReplayStore<TSpan> {
  const mode = replayMode(options);
  const selectedTypes = replayTypes(options, mode);
  const spansByKey = indexTraceSpans(trace);
  const consumedByKey = new Map<string, number>();
  const matches: ReplaySpanMatch<TSpan>[] = [];

  const canReplay = (type: SpanType): boolean => selectedTypes === null || selectedTypes.has(type);

  const consumeSpan = (type: SpanType, name: string, input: unknown): ReplayConsumption<TSpan> | undefined => {
    if (!canReplay(type)) {
      return undefined;
    }

    const key = spanKey(type, name);
    const sequence = consumedByKey.get(key) ?? 0;
    const span = spansByKey.get(key)?.[sequence];

    if (span === undefined) {
      if (mode === 'lenient') {
        return undefined;
      }

      throw new ReplayExhaustedError(`No recorded span remains for ${type}:${name}`, {
        traceId: trace.id,
        context: {
          spanType: type,
          name,
          sequence,
          input
        }
      });
    }

    consumedByKey.set(key, sequence + 1);
    matches.push({
      span,
      strategy: 'sequential',
      sequence
    });

    return {
      span,
      sequence
    };
  };

  return {
    [REPLAY_STORE_MARKER]: true,
    mode,
    canReplay,
    consumeSpan,
    matchedSpans: () => [...matches]
  };
}

/** Checks whether an unknown context value is a GhostTrace replay store. */
export function isReplayStore(value: unknown): value is ReplayStore {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (value as { readonly [REPLAY_STORE_MARKER]?: unknown })[REPLAY_STORE_MARKER] === true;
}
