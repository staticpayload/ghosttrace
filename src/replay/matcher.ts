import { ReplayMismatchError } from '../core/errors.js';
import { deserialize, serialize, type SerializedJsonValue } from '../core/serializer.js';
import { SpanType, type ReplayMatchStrategy, type ReplayMode, type Span } from '../core/types.js';

/** Indexed view of one recorded span used by replay matching. */
export interface IndexedReplaySpan<TSpan extends Span = Span> {
  /** Recorded span. */
  readonly span: TSpan;
  /** Sequence number within this span's type/name bucket. */
  readonly keySequence: number;
  /** Sequence number within the trace's chronological span list. */
  readonly globalSequence: number;
  /** Composite lookup key for type/name/keySequence. */
  readonly compositeKey: string;
}

/** Runtime call information matched against recorded spans. */
export interface SpanMatchRequest {
  /** Runtime span type. */
  readonly type: SpanType;
  /** Runtime operation name. */
  readonly name: string;
  /** Runtime call sequence within the type/name bucket. */
  readonly sequence: number;
  /** Runtime input payload. */
  readonly input: unknown;
}

/** A selected replay span and the tier that selected it. */
export interface SpanMatch<TSpan extends Span = Span> {
  /** Recorded span selected for this runtime call. */
  readonly span: TSpan;
  /** Matching strategy used by the matcher. */
  readonly strategy: ReplayMatchStrategy;
  /** Runtime call sequence within the requested type/name bucket. */
  readonly sequence: number;
  /** Chronological global sequence of the selected recorded span. */
  readonly globalSequence: number;
}

/** Read-only span indexes consumed by the matcher. */
export interface SpanMatcherView<TSpan extends Span = Span> {
  /** Returns the exact type/name/sequence candidate in O(1), if present. */
  readonly exactCandidate: (type: SpanType, name: string, sequence: number) => IndexedReplaySpan<TSpan> | undefined;
  /** Returns candidates with the same type/name, ordered by global sequence. */
  readonly inputCandidates: (type: SpanType, name: string) => readonly IndexedReplaySpan<TSpan>[];
  /** Returns candidates with the same type, ordered by global sequence. */
  readonly sequentialCandidates: (type: SpanType) => readonly IndexedReplaySpan<TSpan>[];
  /** Returns true when a candidate has already been consumed. */
  readonly isConsumed: (candidate: IndexedReplaySpan<TSpan>) => boolean;
}

/** Options for creating a replay span matcher. */
export interface SpanMatcherOptions<TSpan extends Span = Span> {
  /** Trace identifier used in replay diagnostics. */
  readonly traceId: string;
  /** Replay mode used to decide whether sequential fallback is allowed. */
  readonly mode: ReplayMode;
  /** Indexed store view used for candidate selection. */
  readonly view: SpanMatcherView<TSpan>;
  /** Optional policy override for sequential fallback. */
  readonly allowsSequentialFallback?: (type: SpanType, mode: ReplayMode) => boolean;
}

/** Tiered matcher for runtime replay calls against recorded spans. */
export interface SpanMatcher<TSpan extends Span = Span> {
  /** Matches a runtime call using exact, input, then sequential tiers. */
  readonly match: (request: SpanMatchRequest) => SpanMatch<TSpan> | undefined;
}

interface InputDifference {
  readonly path: string;
  readonly kind: 'changed' | 'missing' | 'extra';
  readonly expected?: unknown;
  readonly actual?: unknown;
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

function inputDifferences(
  expected: unknown,
  actual: unknown,
  path = '$',
  differences: InputDifference[] = []
): readonly InputDifference[] {
  if (deepEqual(expected, actual)) {
    return differences;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      differences.push({ path, kind: 'changed', expected, actual });
      return differences;
    }

    const maxLength = Math.max(expected.length, actual.length);
    for (let index = 0; index < maxLength; index += 1) {
      if (index >= expected.length) {
        differences.push({ path: `${path}[${index}]`, kind: 'extra', actual: actual[index] });
      } else if (index >= actual.length) {
        differences.push({ path: `${path}[${index}]`, kind: 'missing', expected: expected[index] });
      } else {
        inputDifferences(expected[index], actual[index], `${path}[${index}]`, differences);
      }
    }

    return differences;
  }

  if (isRecord(expected) || isRecord(actual)) {
    if (!isRecord(expected) || !isRecord(actual)) {
      differences.push({ path, kind: 'changed', expected, actual });
      return differences;
    }

    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const expectedHasKey = Object.prototype.hasOwnProperty.call(expected, key);
      const actualHasKey = Object.prototype.hasOwnProperty.call(actual, key);
      const childPath = `${path}.${key}`;

      if (!expectedHasKey) {
        differences.push({ path: childPath, kind: 'extra', actual: actual[key] });
      } else if (!actualHasKey) {
        differences.push({ path: childPath, kind: 'missing', expected: expected[key] });
      } else {
        inputDifferences(expected[key], actual[key], childPath, differences);
      }
    }

    return differences;
  }

  differences.push({ path, kind: 'changed', expected, actual });
  return differences;
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

/** Default policy for preserving strict replay mismatch behavior. */
export function allowsSequentialFallback(type: SpanType, mode: ReplayMode): boolean {
  return type === SpanType.Random || mode !== 'strict';
}

function firstUnconsumed<TSpan extends Span>(
  candidates: readonly IndexedReplaySpan<TSpan>[],
  isConsumed: (candidate: IndexedReplaySpan<TSpan>) => boolean
): IndexedReplaySpan<TSpan> | undefined {
  return candidates.find((candidate) => !isConsumed(candidate));
}

function firstInputMatch<TSpan extends Span>(
  candidates: readonly IndexedReplaySpan<TSpan>[],
  request: SpanMatchRequest,
  isConsumed: (candidate: IndexedReplaySpan<TSpan>) => boolean
): IndexedReplaySpan<TSpan> | undefined {
  return candidates.find(
    (candidate) =>
      !isConsumed(candidate) && inputMatches(request.type, request.name, candidate.span, request.input)
  );
}

function toMatch<TSpan extends Span>(
  candidate: IndexedReplaySpan<TSpan>,
  request: SpanMatchRequest,
  strategy: ReplayMatchStrategy
): SpanMatch<TSpan> {
  return {
    span: candidate.span,
    strategy,
    sequence: request.sequence,
    globalSequence: candidate.globalSequence
  };
}

function throwInputMismatch<TSpan extends Span>(
  candidate: IndexedReplaySpan<TSpan>,
  request: SpanMatchRequest,
  traceId: string
): never {
  const expectedInput = deserializeSpanInput(candidate.span.input);
  const actualInput = request.input;
  const expectedIdentity = recordedInputIdentity(request.type, request.name, candidate.span.input);
  const actualIdentity = actualInputIdentity(request.type, request.name, request.input);

  throw new ReplayMismatchError(`Recorded span input did not match runtime input for ${request.type}:${request.name}`, {
    traceId,
    spanId: candidate.span.id,
    context: {
      spanType: request.type,
      name: request.name,
      sequence: request.sequence,
      expectedInput,
      actualInput,
      expectedSerializedInput: candidate.span.input,
      expectedIdentity,
      actualIdentity,
      inputDiffs: inputDifferences(expectedIdentity ?? expectedInput, actualIdentity ?? actualInput)
    }
  });
}

/** Creates a tiered span matcher using exact, input, sequential, and miss tiers. */
export function createSpanMatcher<TSpan extends Span>(options: SpanMatcherOptions<TSpan>): SpanMatcher<TSpan> {
  const sequentialPolicy = options.allowsSequentialFallback ?? allowsSequentialFallback;

  return {
    match: (request: SpanMatchRequest): SpanMatch<TSpan> | undefined => {
      const exact = options.view.exactCandidate(request.type, request.name, request.sequence);
      if (
        exact !== undefined &&
        !options.view.isConsumed(exact) &&
        inputMatches(request.type, request.name, exact.span, request.input)
      ) {
        return toMatch(exact, request, 'exact');
      }

      const sameNameCandidates = options.view.inputCandidates(request.type, request.name);
      const inputMatched = firstInputMatch(sameNameCandidates, request, options.view.isConsumed);
      if (inputMatched !== undefined) {
        return toMatch(inputMatched, request, 'input');
      }

      const sameNameSequential = firstUnconsumed(sameNameCandidates, options.view.isConsumed);
      if (sameNameSequential !== undefined && !sequentialPolicy(request.type, options.mode)) {
        throwInputMismatch(sameNameSequential, request, options.traceId);
      }
      if (sameNameCandidates.length > 0 && sameNameSequential === undefined) {
        return undefined;
      }

      const sequential = firstUnconsumed(
        options.view.sequentialCandidates(request.type),
        options.view.isConsumed
      );
      if (sequential !== undefined && !sequentialPolicy(request.type, options.mode)) {
        throwInputMismatch(sequential, request, options.traceId);
      }

      return sequential === undefined ? undefined : toMatch(sequential, request, 'sequential');
    }
  };
}
