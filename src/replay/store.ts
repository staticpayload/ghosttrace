import { ReplayExhaustedError, ReplayMismatchError } from '../core/errors.js';
import { deserialize, serialize, type SerializedJsonValue } from '../core/serializer.js';
import {
  SpanType,
  type ReplayMatchStrategy,
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => deepEqual(item, right[index]));
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function deserializeSpanInput(input: unknown): unknown {
  return deserialize(input as SerializedJsonValue);
}

function envInputIdentity(input: unknown): Record<string, unknown> | undefined {
  const operation = recordValue(input, 'operation');
  const key = recordValue(input, 'key');

  if (typeof key !== 'string') {
    return undefined;
  }

  const identity: Record<string, unknown> = { key };
  if (typeof operation === 'string') {
    identity.operation = operation;
  }

  return identity;
}

function timerSetInputIdentity(input: unknown): Record<string, unknown> | undefined {
  const operation = recordValue(input, 'operation');
  const delay = recordValue(input, 'delay');
  const callbackName = recordValue(input, 'callbackName');

  if (typeof operation !== 'string' || typeof delay !== 'number') {
    return undefined;
  }

  const identity: Record<string, unknown> = {
    operation,
    delay
  };

  if (typeof callbackName === 'string') {
    identity.callbackName = callbackName;
  }

  return identity;
}

function timerClearInputIdentity(input: unknown): Record<string, unknown> | undefined {
  const operation = recordValue(input, 'operation');
  const timerId = recordValue(input, 'timerId');

  if (typeof operation !== 'string' || typeof timerId !== 'string') {
    return undefined;
  }

  return {
    operation,
    timerId
  };
}

function timerOperationInputIdentity(input: unknown): Record<string, unknown> | undefined {
  const operation = recordValue(input, 'operation');

  if (typeof operation !== 'string') {
    return undefined;
  }

  return { operation };
}

function timerInputIdentity(name: string, input: unknown): Record<string, unknown> | undefined {
  switch (name) {
    case 'setTimeout':
    case 'setInterval':
      return timerSetInputIdentity(input);
    case 'clearTimeout':
    case 'clearInterval':
      return timerClearInputIdentity(input);
    default:
      return timerOperationInputIdentity(input);
  }
}

function copyDefinedRecordValue(target: Record<string, unknown>, source: unknown, key: string): void {
  const value = recordValue(source, key);

  if (value !== undefined) {
    target[key] = value;
  }
}

function fsInputIdentity(input: unknown): Record<string, unknown> | undefined {
  const operation = recordValue(input, 'operation');
  const api = recordValue(input, 'api');

  if (typeof operation !== 'string' || typeof api !== 'string') {
    return undefined;
  }

  const identity: Record<string, unknown> = {
    operation,
    api
  };

  if (operation === 'rename') {
    copyDefinedRecordValue(identity, input, 'oldPath');
    copyDefinedRecordValue(identity, input, 'newPath');
    return identity;
  }

  copyDefinedRecordValue(identity, input, 'path');
  copyDefinedRecordValue(identity, input, 'options');
  copyDefinedRecordValue(identity, input, 'mode');
  return identity;
}

function recordedInputIdentity(type: SpanType, name: string, input: unknown): unknown | undefined {
  switch (type) {
    case SpanType.Env:
      return envInputIdentity(deserializeSpanInput(input));
    case SpanType.Timer:
      return timerInputIdentity(name, deserializeSpanInput(input));
    case SpanType.Random:
      return undefined;
    case SpanType.Fs:
      return fsInputIdentity(deserializeSpanInput(input));
    default:
      return input;
  }
}

function actualInputIdentity(type: SpanType, name: string, input: unknown): unknown | undefined {
  switch (type) {
    case SpanType.Env:
      return envInputIdentity(input);
    case SpanType.Timer:
      return timerInputIdentity(name, input);
    case SpanType.Random:
      return undefined;
    case SpanType.Fs:
      return fsInputIdentity(input);
    default:
      return serialize(input);
  }
}

function inputMatches(type: SpanType, name: string, span: Span, actualInput: unknown): boolean {
  const recordedIdentity = recordedInputIdentity(type, name, span.input);
  const actualIdentity = actualInputIdentity(type, name, actualInput);

  if (recordedIdentity === undefined || actualIdentity === undefined) {
    return false;
  }

  return deepEqual(recordedIdentity, actualIdentity);
}

function allowsSequentialFallback(type: SpanType, mode: ReplayMode): boolean {
  return type === SpanType.Random || mode !== 'strict';
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
  const runtimeSequenceByKey = new Map<string, number>();
  const consumedIndexesByKey = new Map<string, Set<number>>();
  const matches: ReplaySpanMatch<TSpan>[] = [];

  const canReplay = (type: SpanType): boolean => selectedTypes === null || selectedTypes.has(type);

  const isConsumed = (key: string, index: number): boolean => consumedIndexesByKey.get(key)?.has(index) ?? false;

  const markConsumed = (key: string, index: number): void => {
    const consumedIndexes = consumedIndexesByKey.get(key) ?? new Set<number>();
    consumedIndexes.add(index);
    consumedIndexesByKey.set(key, consumedIndexes);
  };

  const firstUnconsumedIndex = (key: string, spans: readonly TSpan[]): number | undefined => {
    for (let index = 0; index < spans.length; index += 1) {
      if (!isConsumed(key, index)) {
        return index;
      }
    }

    return undefined;
  };

  const inputMatchedIndex = (
    key: string,
    spans: readonly TSpan[],
    type: SpanType,
    name: string,
    input: unknown
  ): number | undefined => {
    for (let index = 0; index < spans.length; index += 1) {
      if (!isConsumed(key, index) && inputMatches(type, name, spans[index] as Span, input)) {
        return index;
      }
    }

    return undefined;
  };

  const selectSpan = (
    key: string,
    spans: readonly TSpan[],
    sequence: number,
    type: SpanType,
    name: string,
    input: unknown
  ): { readonly index: number; readonly strategy: ReplayMatchStrategy } | undefined => {
    const sequenceSpan = spans[sequence];
    if (sequenceSpan !== undefined && !isConsumed(key, sequence) && inputMatches(type, name, sequenceSpan, input)) {
      return {
        index: sequence,
        strategy: 'exact'
      };
    }

    const matchedByInput = inputMatchedIndex(key, spans, type, name, input);
    if (matchedByInput !== undefined) {
      return {
        index: matchedByInput,
        strategy: 'input'
      };
    }

    const sequentialIndex = firstUnconsumedIndex(key, spans);
    if (sequentialIndex !== undefined && !allowsSequentialFallback(type, mode)) {
      const nextSpan = spans[sequentialIndex];
      if (nextSpan === undefined) {
        return undefined;
      }

      throw new ReplayMismatchError(`Recorded span input did not match runtime input for ${type}:${name}`, {
        traceId: trace.id,
        spanId: nextSpan.id,
        context: {
          spanType: type,
          name,
          sequence,
          expectedInput: nextSpan.input,
          expectedIdentity: recordedInputIdentity(type, name, nextSpan.input),
          actualIdentity: actualInputIdentity(type, name, input)
        }
      });
    }

    return sequentialIndex === undefined
      ? undefined
      : {
          index: sequentialIndex,
          strategy: 'sequential'
        };
  };

  const consumeSpan = (type: SpanType, name: string, input: unknown): ReplayConsumption<TSpan> | undefined => {
    if (!canReplay(type)) {
      return undefined;
    }

    const key = spanKey(type, name);
    const sequence = runtimeSequenceByKey.get(key) ?? 0;
    const spans = spansByKey.get(key) ?? [];
    const selectedSpan = selectSpan(key, spans, sequence, type, name, input);

    if (selectedSpan === undefined) {
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

    const span = spans[selectedSpan.index] as TSpan;
    runtimeSequenceByKey.set(key, sequence + 1);
    markConsumed(key, selectedSpan.index);
    matches.push({
      span,
      strategy: selectedSpan.strategy,
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
