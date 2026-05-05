import { ReplayExhaustedError, ReplayMismatchError } from '../core/errors.js';
import {
  SpanType,
  type ReplayMode,
  type ReplayOptions,
  type ReplaySpanMatch,
  type Span,
  type Trace
} from '../core/types.js';
import { createSpanMatcher, type IndexedReplaySpan, type SpanMatcherView } from './matcher.js';

export {
  createSpanMatcher,
  type IndexedReplaySpan,
  type SpanMatch,
  type SpanMatcher,
  type SpanMatcherOptions,
  type SpanMatchRequest
} from './matcher.js';

const REPLAY_STORE_MARKER = Symbol.for('ghosttrace.replayStore');

/** Recorded span returned by a replay-store consumption. */
export interface ReplayConsumption<TSpan extends Span = Span> {
  /** Span consumed for the replayed runtime call. */
  readonly span: TSpan;
  /** Zero-based runtime call sequence for this span type/name key. */
  readonly sequence: number;
}

/** Indexed replay store used by deterministic replay interceptors. */
export interface ReplayStore<TSpan extends Span = Span> {
  /** Marker used to safely identify GhostTrace replay stores across modules. */
  readonly [REPLAY_STORE_MARKER]: true;
  /** Replay mode selected for this execution. */
  readonly mode: ReplayMode;
  /** Returns true when the supplied span type should be replayed. */
  readonly canReplay: (type: SpanType) => boolean;
  /** Looks up a span by type/name sequence using the composite O(1) index. */
  readonly getSpan: (type: SpanType, name: string, sequence: number) => TSpan | undefined;
  /** Looks up a span by a prebuilt `type:name:sequence` composite key. */
  readonly getSpanByCompositeKey: (key: string) => TSpan | undefined;
  /** Looks up a span by chronological global sequence. */
  readonly getSpanByGlobalSequence: (sequence: number) => TSpan | undefined;
  /** Consumes the best recorded span for a runtime replay call. */
  readonly consumeSpan: (type: SpanType, name: string, input: unknown) => ReplayConsumption<TSpan> | undefined;
  /** Returns all spans matched so far in replay order. */
  readonly matchedSpans: () => readonly ReplaySpanMatch<TSpan>[];
  /** Returns replayable recorded spans that were not consumed. */
  readonly unmatchedSpans: () => readonly TSpan[];
}

interface ReplayIndex<TSpan extends Span> {
  readonly byCompositeKey: ReadonlyMap<string, IndexedReplaySpan<TSpan>>;
  readonly byGlobalSequence: ReadonlyMap<number, IndexedReplaySpan<TSpan>>;
  readonly byTypeName: ReadonlyMap<string, readonly IndexedReplaySpan<TSpan>[]>;
  readonly byType: ReadonlyMap<SpanType, readonly IndexedReplaySpan<TSpan>[]>;
}

function typeNameKey(type: SpanType, name: string): string {
  return `${type}:${name}`;
}

/** Builds the canonical composite replay key for type/name sequence lookups. */
export function replayCompositeKey(type: SpanType, name: string, sequence: number): string {
  return `${type}:${name}:${sequence}`;
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

function appendIndexedSpan<TKey, TSpan extends Span>(
  map: Map<TKey, IndexedReplaySpan<TSpan>[]>,
  key: TKey,
  indexedSpan: IndexedReplaySpan<TSpan>
): void {
  const spans = map.get(key) ?? [];
  spans.push(indexedSpan);
  map.set(key, spans);
}

function indexTraceSpans<TSpan extends Span>(trace: Trace<TSpan>): ReplayIndex<TSpan> {
  const byCompositeKey = new Map<string, IndexedReplaySpan<TSpan>>();
  const byGlobalSequence = new Map<number, IndexedReplaySpan<TSpan>>();
  const byTypeName = new Map<string, IndexedReplaySpan<TSpan>[]>();
  const byType = new Map<SpanType, IndexedReplaySpan<TSpan>[]>();
  const sequenceByTypeName = new Map<string, number>();

  for (const [globalSequence, span] of trace.spans.entries()) {
    const key = typeNameKey(span.type, span.name);
    const keySequence = sequenceByTypeName.get(key) ?? 0;
    const compositeKey = replayCompositeKey(span.type, span.name, keySequence);
    const indexedSpan: IndexedReplaySpan<TSpan> = {
      span,
      keySequence,
      globalSequence,
      compositeKey
    };

    sequenceByTypeName.set(key, keySequence + 1);
    byCompositeKey.set(compositeKey, indexedSpan);
    byGlobalSequence.set(globalSequence, indexedSpan);
    appendIndexedSpan(byTypeName, key, indexedSpan);
    appendIndexedSpan(byType, span.type, indexedSpan);
  }

  return {
    byCompositeKey,
    byGlobalSequence,
    byTypeName,
    byType
  };
}

function replayMissError(
  trace: Trace,
  type: SpanType,
  name: string,
  sequence: number,
  input: unknown,
  availableSpanCount: number
): ReplayMismatchError {
  return new ReplayMismatchError(`No recorded span matched runtime call for ${type}:${name}`, {
    traceId: trace.id,
    context: {
      spanType: type,
      name,
      sequence,
      input,
      availableSpanCount
    }
  });
}

function replayExhaustedError(
  trace: Trace,
  type: SpanType,
  name: string,
  sequence: number,
  input: unknown,
  availableSpanCount: number
): ReplayExhaustedError {
  return new ReplayExhaustedError(`Replay exhausted recorded spans for ${type}:${name}`, {
    traceId: trace.id,
    context: {
      spanType: type,
      name,
      sequence,
      input,
      attemptedCount: sequence + 1,
      availableSpanCount
    }
  });
}

function isReplayableSpanType(type: SpanType): boolean {
  return type !== SpanType.Function && type !== SpanType.Error;
}

function warnLenientPassthrough(
  trace: Trace,
  type: SpanType,
  name: string,
  sequence: number,
  input: unknown,
  availableSpanCount: number
): void {
  console.warn('GhostTrace lenient replay pass-through: no recorded span matched runtime call', {
    traceId: trace.id,
    spanType: type,
    name,
    sequence,
    input,
    availableSpanCount
  });
}

/** Creates an indexed replay store over a trace's chronological span list. */
export function createReplayStore<TSpan extends Span>(
  trace: Trace<TSpan>,
  options: ReplayOptions = {}
): ReplayStore<TSpan> {
  const mode = replayMode(options);
  const selectedTypes = replayTypes(options, mode);
  const spanIndex = indexTraceSpans(trace);
  const runtimeSequenceByKey = new Map<string, number>();
  const consumedGlobalSequences = new Set<number>();
  const matches: ReplaySpanMatch<TSpan>[] = [];

  const canReplay = (type: SpanType): boolean => selectedTypes === null || selectedTypes.has(type);

  const getSpanByCompositeKey = (key: string): TSpan | undefined => spanIndex.byCompositeKey.get(key)?.span;

  const getSpan = (type: SpanType, name: string, sequence: number): TSpan | undefined =>
    getSpanByCompositeKey(replayCompositeKey(type, name, sequence));

  const getSpanByGlobalSequence = (sequence: number): TSpan | undefined =>
    spanIndex.byGlobalSequence.get(sequence)?.span;

  const matcherView: SpanMatcherView<TSpan> = {
    exactCandidate: (type, name, sequence) => spanIndex.byCompositeKey.get(replayCompositeKey(type, name, sequence)),
    inputCandidates: (type, name) => spanIndex.byTypeName.get(typeNameKey(type, name)) ?? [],
    sequentialCandidates: (type) => spanIndex.byType.get(type) ?? [],
    isConsumed: (candidate) => consumedGlobalSequences.has(candidate.globalSequence)
  };
  const matcher = createSpanMatcher({
    traceId: trace.id,
    mode,
    view: matcherView
  });

  const consumeSpan = (type: SpanType, name: string, input: unknown): ReplayConsumption<TSpan> | undefined => {
    if (!canReplay(type)) {
      return undefined;
    }

    const key = typeNameKey(type, name);
    const sequence = runtimeSequenceByKey.get(key) ?? 0;
    const selectedSpan = matcher.match({
      type,
      name,
      sequence,
      input
    });

    if (selectedSpan === undefined) {
      const typeNameCandidateCount = spanIndex.byTypeName.get(key)?.length ?? 0;
      if (mode === 'lenient') {
        warnLenientPassthrough(trace, type, name, sequence, input, spanIndex.byType.get(type)?.length ?? 0);
        return undefined;
      }
      if (typeNameCandidateCount > 0 && sequence >= typeNameCandidateCount) {
        throw replayExhaustedError(trace, type, name, sequence, input, typeNameCandidateCount);
      }

      throw replayMissError(trace, type, name, sequence, input, spanIndex.byType.get(type)?.length ?? 0);
    }

    runtimeSequenceByKey.set(key, sequence + 1);
    consumedGlobalSequences.add(selectedSpan.globalSequence);
    matches.push({
      span: selectedSpan.span,
      strategy: selectedSpan.strategy,
      sequence
    });

    return {
      span: selectedSpan.span,
      sequence
    };
  };

  return {
    [REPLAY_STORE_MARKER]: true,
    mode,
    canReplay,
    getSpan,
    getSpanByCompositeKey,
    getSpanByGlobalSequence,
    consumeSpan,
    matchedSpans: (): readonly ReplaySpanMatch<TSpan>[] => [...matches],
    unmatchedSpans: (): readonly TSpan[] =>
      [...spanIndex.byGlobalSequence.values()]
        .filter(
          (candidate) =>
            isReplayableSpanType(candidate.span.type) &&
            canReplay(candidate.span.type) &&
            !consumedGlobalSequences.has(candidate.globalSequence)
        )
        .map((candidate) => candidate.span)
  };
}

/** Checks whether an unknown context value is a GhostTrace replay store. */
export function isReplayStore(value: unknown): value is ReplayStore {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (value as { readonly [REPLAY_STORE_MARKER]?: unknown })[REPLAY_STORE_MARKER] === true;
}
