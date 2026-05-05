import { Buffer } from 'node:buffer';
import { getTraceContext, type TraceContext } from '../core/context.js';
import { ReplayMismatchError } from '../core/errors.js';
import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanMetadata } from '../core/types.js';
import { isReplayStore, type ReplayStore } from '../replay/store.js';
import { isRecord, spanErrorFromUnknown } from './shared.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';

const RANDOM_SENTINEL = '__GHOSTTRACE_RANDOM_INTERCEPTOR_SENTINEL__';

type IntegerTypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array;

interface ActiveRandomSession {
  readonly addSpan: (span: Span) => void;
}

interface ActiveRandomContext {
  readonly context: TraceContext;
  readonly session: ActiveRandomSession;
  readonly replayStore?: ReplayStore;
}

let originalMathRandom: typeof Math.random | undefined;
let patchedMathRandom: typeof Math.random | undefined;
let originalCryptoGetRandomValues: Crypto['getRandomValues'] | undefined;
let patchedCryptoGetRandomValues: Crypto['getRandomValues'] | undefined;

const activeRandomSessions = new Map<string, ActiveRandomSession>();

function markRandomInterceptorBundled(): string {
  return RANDOM_SENTINEL;
}

function activeRandomContext(): ActiveRandomContext | undefined {
  const context = getTraceContext();

  if (context === undefined) {
    return undefined;
  }

  const session = activeRandomSessions.get(context.traceId);
  if (session === undefined) {
    return undefined;
  }

  if (context.mode === 'replay') {
    const replayStore = isReplayStore(context.replayStore) ? context.replayStore : undefined;
    if (replayStore === undefined || !replayStore.canReplay(SpanType.Random)) {
      return undefined;
    }

    return { context, session, replayStore };
  }

  return { context, session };
}

function createRandomSpan(
  context: TraceContext,
  name: string,
  startTime: number,
  input: unknown,
  output: unknown,
  error: unknown,
  metadata: SpanMetadata
): Span {
  const endTime = context.clock.now();

  return {
    id: context.idGenerator.next(),
    parentId: context.currentSpan?.id ?? null,
    type: SpanType.Random,
    name,
    startTime,
    endTime,
    duration: endTime - startTime,
    input: serialize(input),
    output: serialize(output),
    children: [],
    error: error === null ? null : spanErrorFromUnknown(error),
    metadata
  };
}

function addRandomSpan(
  active: ActiveRandomContext,
  name: string,
  startTime: number,
  input: unknown,
  output: unknown,
  error: unknown,
  metadata: SpanMetadata
): void {
  active.session.addSpan(createRandomSpan(active.context, name, startTime, input, output, error, metadata));
}

function numberFromSpanOutput(output: unknown, span: Span): number {
  if (typeof output === 'number') {
    return output;
  }

  throw new ReplayMismatchError(`Recorded random span ${span.name} is missing numeric output`, {
    spanId: span.id,
    context: { output: span.output }
  });
}

function stringFromRecord(output: unknown, key: string, span: Span): string {
  if (isRecord(output) && typeof output[key] === 'string') {
    return output[key];
  }

  throw new ReplayMismatchError(`Recorded random span ${span.name} is missing string output.${key}`, {
    spanId: span.id,
    context: { output: span.output }
  });
}

function numberFromRecord(output: unknown, key: string, span: Span): number {
  if (isRecord(output) && typeof output[key] === 'number') {
    return output[key];
  }

  throw new ReplayMismatchError(`Recorded random span ${span.name} is missing numeric output.${key}`, {
    spanId: span.id,
    context: { output: span.output }
  });
}

function recordMathRandom(active: ActiveRandomContext): number {
  const input = { source: 'math', operation: 'random' };
  const startTime = active.context.clock.now();

  try {
    const value = originalMathRandom?.() ?? Math.random();
    addRandomSpan(active, 'Math.random', startTime, input, value, null, {
      source: 'math',
      operation: 'random'
    });
    return value;
  } catch (error) {
    addRandomSpan(active, 'Math.random', startTime, input, undefined, error, {
      source: 'math',
      operation: 'random'
    });
    throw error;
  }
}

function replayMathRandom(active: ActiveRandomContext): number {
  const span = active.replayStore?.consumeSpan(SpanType.Random, 'Math.random', {
    source: 'math',
    operation: 'random'
  })?.span;

  if (span === undefined) {
    return originalMathRandom?.() ?? Math.random();
  }

  return numberFromSpanOutput(span.output, span);
}

function isIntegerTypedArray(value: unknown): value is IntegerTypedArray {
  return (
    value instanceof Int8Array ||
    value instanceof Uint8Array ||
    value instanceof Uint8ClampedArray ||
    value instanceof Int16Array ||
    value instanceof Uint16Array ||
    value instanceof Int32Array ||
    value instanceof Uint32Array ||
    (typeof BigInt64Array !== 'undefined' && value instanceof BigInt64Array) ||
    (typeof BigUint64Array !== 'undefined' && value instanceof BigUint64Array)
  );
}

function typedArrayBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function bytesBase64(view: ArrayBufferView): string {
  return Buffer.from(typedArrayBytes(view)).toString('base64');
}

function typedArrayInput(value: unknown): Record<string, unknown> {
  if (!ArrayBuffer.isView(value)) {
    return {
      constructorName: typeof value,
      byteLength: 0
    };
  }

  return {
    constructorName: value.constructor.name,
    byteLength: value.byteLength
  };
}

function fillReplayBytes(target: unknown, span: Span): void {
  if (!isIntegerTypedArray(target)) {
    throw new TypeError('crypto.getRandomValues replay target must be an integer typed array');
  }

  const expectedByteLength = numberFromRecord(span.output, 'byteLength', span);
  if (target.byteLength !== expectedByteLength) {
    throw new ReplayMismatchError('crypto.getRandomValues replay target length differs from recorded span', {
      spanId: span.id,
      context: {
        expectedByteLength,
        actualByteLength: target.byteLength
      }
    });
  }

  const bytes = Buffer.from(stringFromRecord(span.output, 'bytesBase64', span), 'base64');
  typedArrayBytes(target).set(bytes);
}

function callOriginalGetRandomValues(args: readonly unknown[]): unknown {
  if (originalCryptoGetRandomValues === undefined || globalThis.crypto === undefined) {
    throw new TypeError('crypto.getRandomValues is not available');
  }

  return Reflect.apply(originalCryptoGetRandomValues, globalThis.crypto, [...args]);
}

function recordCryptoGetRandomValues(active: ActiveRandomContext, args: readonly unknown[]): unknown {
  const target = args[0];
  const input = typedArrayInput(target);
  const startTime = active.context.clock.now();

  try {
    const output = callOriginalGetRandomValues(args);
    if (ArrayBuffer.isView(output)) {
      addRandomSpan(
        active,
        'crypto.getRandomValues',
        startTime,
        input,
        {
          bytesBase64: bytesBase64(output),
          byteLength: output.byteLength
        },
        null,
        {
          source: 'crypto',
          operation: 'getRandomValues',
          byteLength: output.byteLength
        }
      );
    }
    return output;
  } catch (error) {
    addRandomSpan(active, 'crypto.getRandomValues', startTime, input, undefined, error, {
      source: 'crypto',
      operation: 'getRandomValues'
    });
    throw error;
  }
}

function replayCryptoGetRandomValues(active: ActiveRandomContext, args: readonly unknown[]): unknown {
  const target = args[0];
  const span = active.replayStore?.consumeSpan(SpanType.Random, 'crypto.getRandomValues', typedArrayInput(target))?.span;

  if (span === undefined) {
    return callOriginalGetRandomValues(args);
  }

  fillReplayBytes(target, span);
  return target;
}

function installRandomPatches(): void {
  if (patchedMathRandom === undefined) {
    originalMathRandom = Math.random;
    patchedMathRandom = function ghosttraceMathRandom(): number {
      const active = activeRandomContext();
      if (active === undefined) {
        return originalMathRandom?.() ?? Math.random();
      }

      return active.context.mode === 'replay' ? replayMathRandom(active) : recordMathRandom(active);
    };
    Math.random = patchedMathRandom;
  }

  if (
    patchedCryptoGetRandomValues === undefined &&
    typeof globalThis.crypto === 'object' &&
    globalThis.crypto !== null &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    originalCryptoGetRandomValues = globalThis.crypto.getRandomValues;
    patchedCryptoGetRandomValues = function ghosttraceGetRandomValues<TArray extends ArrayBufferView | null>(
      array: TArray
    ): TArray {
      const active = activeRandomContext();
      if (active === undefined) {
        return callOriginalGetRandomValues([array]) as TArray;
      }

      return (active.context.mode === 'replay'
        ? replayCryptoGetRandomValues(active, [array])
        : recordCryptoGetRandomValues(active, [array])) as TArray;
    };
    globalThis.crypto.getRandomValues = patchedCryptoGetRandomValues;
  }
}

function restoreRandomPatchesIfIdle(): void {
  if (activeRandomSessions.size > 0) {
    return;
  }

  if (patchedMathRandom !== undefined && originalMathRandom !== undefined && Math.random === patchedMathRandom) {
    Math.random = originalMathRandom;
  }
  if (
    patchedCryptoGetRandomValues !== undefined &&
    originalCryptoGetRandomValues !== undefined &&
    typeof globalThis.crypto === 'object' &&
    globalThis.crypto !== null &&
    globalThis.crypto.getRandomValues === patchedCryptoGetRandomValues
  ) {
    globalThis.crypto.getRandomValues = originalCryptoGetRandomValues;
  }

  originalMathRandom = undefined;
  patchedMathRandom = undefined;
  originalCryptoGetRandomValues = undefined;
  patchedCryptoGetRandomValues = undefined;
}

function randomAvailable(): boolean {
  return typeof Math.random === 'function';
}

/** Random interceptor for Math.random and crypto.getRandomValues nondeterminism. */
export const randomInterceptor: Interceptor = {
  name: 'random',
  install: (context: InterceptorContext): Teardown => {
    void markRandomInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return () => undefined;
    }

    activeRandomSessions.set(traceContext.traceId, {
      addSpan: context.addSpan
    });
    installRandomPatches();

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }

      installed = false;
      activeRandomSessions.delete(traceContext.traceId);
      restoreRandomPatchesIfIdle();
    };
  },
  isAvailable: randomAvailable
};
