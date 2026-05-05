import { getTraceContext, type TraceContext } from '../core/context.js';
import { ReplayMismatchError } from '../core/errors.js';
import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanMetadata } from '../core/types.js';
import { isReplayStore, type ReplayStore } from '../replay/store.js';
import { isRecord, spanErrorFromUnknown } from './shared.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';

const TIMER_SENTINEL = '__GHOSTTRACE_TIMER_INTERCEPTOR_SENTINEL__';

interface ActiveTimerSession {
  readonly addSpan: (span: Span) => void;
  readonly timerIds: Map<unknown, string>;
  nextTimerSequence: number;
}

interface ActiveTimerContext {
  readonly context: TraceContext;
  readonly session: ActiveTimerSession;
  readonly replayStore?: ReplayStore;
}

interface ReplayTimerHandle {
  readonly __ghosttraceTimerId: string;
}

let originalSetTimeout: typeof globalThis.setTimeout | undefined;
let patchedSetTimeout: typeof globalThis.setTimeout | undefined;
let originalSetInterval: typeof globalThis.setInterval | undefined;
let patchedSetInterval: typeof globalThis.setInterval | undefined;
let originalClearTimeout: typeof globalThis.clearTimeout | undefined;
let patchedClearTimeout: typeof globalThis.clearTimeout | undefined;
let originalClearInterval: typeof globalThis.clearInterval | undefined;
let patchedClearInterval: typeof globalThis.clearInterval | undefined;
let originalDate: DateConstructor | undefined;
let patchedDate: DateConstructor | undefined;

const activeTimerSessions = new Map<string, ActiveTimerSession>();

function markTimerInterceptorBundled(): string {
  return TIMER_SENTINEL;
}

function activeTimerContext(): ActiveTimerContext | undefined {
  const context = getTraceContext();

  if (context === undefined) {
    return undefined;
  }

  const session = activeTimerSessions.get(context.traceId);
  if (session === undefined) {
    return undefined;
  }

  if (context.mode === 'replay') {
    const replayStore = isReplayStore(context.replayStore) ? context.replayStore : undefined;
    if (replayStore === undefined || !replayStore.canReplay(SpanType.Timer)) {
      return undefined;
    }

    return { context, session, replayStore };
  }

  return { context, session };
}

function nextTimerId(session: ActiveTimerSession): string {
  const timerId = `timer_${String(session.nextTimerSequence).padStart(4, '0')}`;
  session.nextTimerSequence += 1;
  return timerId;
}

function timerIdForHandle(session: ActiveTimerSession, handle: unknown): string {
  return session.timerIds.get(handle) ?? 'untracked';
}

function normalizeDelay(value: unknown): number {
  if (value === undefined) {
    return 0;
  }

  const delay = Number(value);
  return Number.isFinite(delay) ? delay : 0;
}

function callbackName(callback: unknown): string | undefined {
  if (typeof callback !== 'function') {
    return undefined;
  }

  return callback.name.length > 0 ? callback.name : '<anonymous>';
}

function createTimerSpan(
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
    type: SpanType.Timer,
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

function addTimerSpan(
  active: ActiveTimerContext,
  name: string,
  startTime: number,
  input: unknown,
  output: unknown,
  error: unknown,
  metadata: SpanMetadata
): void {
  active.session.addSpan(createTimerSpan(active.context, name, startTime, input, output, error, metadata));
}

function callOriginalTimer(original: unknown, args: readonly unknown[]): unknown {
  if (typeof original !== 'function') {
    throw new TypeError('Timer API is not available');
  }

  return Reflect.apply(original, globalThis, [...args]);
}

function recordSetTimer(active: ActiveTimerContext, name: 'setTimeout' | 'setInterval', args: readonly unknown[], original: unknown): unknown {
  const delay = normalizeDelay(args[1]);
  const timerId = nextTimerId(active.session);
  const input = {
    operation: name,
    delay,
    timerId,
    callbackName: callbackName(args[0])
  };
  const metadata = {
    operation: name,
    delay,
    timerId,
    callbackName: callbackName(args[0])
  };
  const startTime = active.context.clock.now();

  try {
    const handle = callOriginalTimer(original, args);
    active.session.timerIds.set(handle, timerId);
    addTimerSpan(active, name, startTime, input, { timerId }, null, metadata);
    return handle;
  } catch (error) {
    addTimerSpan(active, name, startTime, input, { timerId }, error, metadata);
    throw error;
  }
}

function replaySetTimer(active: ActiveTimerContext, name: 'setTimeout' | 'setInterval', args: readonly unknown[]): unknown {
  const delay = normalizeDelay(args[1]);
  const input = {
    operation: name,
    delay,
    callbackName: callbackName(args[0])
  };
  const span = active.replayStore?.consumeSpan(SpanType.Timer, name, input)?.span;
  if (span === undefined) {
    return callOriginalTimer(name === 'setTimeout' ? originalSetTimeout : originalSetInterval, args);
  }

  const timerId = timerIdFromSpanOutput(span.output);
  const handle: ReplayTimerHandle = { __ghosttraceTimerId: timerId };
  active.session.timerIds.set(handle, timerId);

  if (name === 'setTimeout' && typeof args[0] === 'function') {
    Reflect.apply(args[0], globalThis, args.slice(2));
  }

  return handle;
}

function recordClearTimer(
  active: ActiveTimerContext,
  name: 'clearTimeout' | 'clearInterval',
  args: readonly unknown[],
  original: unknown
): unknown {
  const handle = args[0];
  const timerId = timerIdForHandle(active.session, handle);
  const input = {
    operation: name,
    timerId,
    known: timerId !== 'untracked'
  };
  const metadata = {
    operation: name,
    timerId
  };
  const startTime = active.context.clock.now();

  try {
    const output = callOriginalTimer(original, args);
    active.session.timerIds.delete(handle);
    addTimerSpan(active, name, startTime, input, { timerId, cleared: true }, null, metadata);
    return output;
  } catch (error) {
    addTimerSpan(active, name, startTime, input, { timerId, cleared: false }, error, metadata);
    throw error;
  }
}

function replayClearTimer(active: ActiveTimerContext, name: 'clearTimeout' | 'clearInterval', args: readonly unknown[]): undefined {
  const handle = args[0];
  const timerId = timerIdForHandle(active.session, handle);
  const input = {
    operation: name,
    timerId,
    known: timerId !== 'untracked'
  };
  const span = active.replayStore?.consumeSpan(SpanType.Timer, name, input)?.span;

  if (span === undefined) {
    callOriginalTimer(name === 'clearTimeout' ? originalClearTimeout : originalClearInterval, args);
    return undefined;
  }

  active.session.timerIds.delete(handle);
  return undefined;
}

function timerIdFromSpanOutput(output: unknown): string {
  if (isRecord(output) && typeof output.timerId === 'string') {
    return output.timerId;
  }

  return 'untracked';
}

function numberFromSpanOutput(output: unknown, key: string, span: Span): number {
  if (isRecord(output) && typeof output[key] === 'number') {
    return output[key];
  }

  throw new ReplayMismatchError(`Recorded timer span ${span.name} is missing numeric output.${key}`, {
    spanId: span.id,
    context: { output: span.output }
  });
}

function stringFromSpanOutput(output: unknown, key: string, span: Span): string {
  if (isRecord(output) && typeof output[key] === 'string') {
    return output[key];
  }

  throw new ReplayMismatchError(`Recorded timer span ${span.name} is missing string output.${key}`, {
    spanId: span.id,
    context: { output: span.output }
  });
}

function recordDateNow(active: ActiveTimerContext): number {
  const dateConstructor = originalDate ?? Date;
  const input = { operation: 'Date.now' };
  const startTime = active.context.clock.now();

  try {
    const value = dateConstructor.now();
    addTimerSpan(active, 'Date.now', startTime, input, { value }, null, {
      operation: 'Date.now'
    });
    return value;
  } catch (error) {
    addTimerSpan(active, 'Date.now', startTime, input, undefined, error, {
      operation: 'Date.now'
    });
    throw error;
  }
}

function replayDateNow(active: ActiveTimerContext): number {
  const span = active.replayStore?.consumeSpan(SpanType.Timer, 'Date.now', { operation: 'Date.now' })?.span;
  if (span === undefined) {
    return (originalDate ?? Date).now();
  }

  return numberFromSpanOutput(span.output, 'value', span);
}

function recordDateCall(active: ActiveTimerContext): string {
  const dateConstructor = originalDate ?? Date;
  const input = { operation: 'Date' };
  const startTime = active.context.clock.now();
  const timestamp = dateConstructor.now();
  const value = new dateConstructor(timestamp).toString();

  addTimerSpan(active, 'Date', startTime, input, { value, timestamp }, null, {
    operation: 'Date'
  });

  return value;
}

function replayDateCall(active: ActiveTimerContext): string {
  const span = active.replayStore?.consumeSpan(SpanType.Timer, 'Date', { operation: 'Date' })?.span;
  if (span === undefined) {
    return Reflect.apply(originalDate ?? Date, undefined, []) as string;
  }

  return stringFromSpanOutput(span.output, 'value', span);
}

function recordNewDate(active: ActiveTimerContext): Date {
  const dateConstructor = originalDate ?? Date;
  const input = { operation: 'new Date' };
  const startTime = active.context.clock.now();
  const date = new dateConstructor();
  const timestamp = date.getTime();

  addTimerSpan(active, 'new Date', startTime, input, { timestamp, iso: date.toISOString() }, null, {
    operation: 'new Date'
  });

  return date;
}

function replayNewDate(active: ActiveTimerContext): Date {
  const span = active.replayStore?.consumeSpan(SpanType.Timer, 'new Date', { operation: 'new Date' })?.span;
  const dateConstructor = originalDate ?? Date;
  if (span === undefined) {
    return new dateConstructor();
  }

  return new dateConstructor(numberFromSpanOutput(span.output, 'timestamp', span));
}

function createPatchedDateConstructor(dateConstructor: DateConstructor): DateConstructor {
  const ghosttraceDate = function Date(this: unknown, ...args: unknown[]): string | globalThis.Date {
    const active = activeTimerContext();

    if (new.target === undefined) {
      if (args.length === 0 && active !== undefined) {
        return active.context.mode === 'replay' ? replayDateCall(active) : recordDateCall(active);
      }

      return Reflect.apply(dateConstructor, undefined, args) as string;
    }

    if (args.length === 0 && active !== undefined) {
      return active.context.mode === 'replay' ? replayNewDate(active) : recordNewDate(active);
    }

    return Reflect.construct(dateConstructor, args, new.target) as globalThis.Date;
  };

  Object.setPrototypeOf(ghosttraceDate, dateConstructor);
  Object.defineProperty(ghosttraceDate, 'prototype', {
    value: dateConstructor.prototype
  });
  Object.defineProperty(ghosttraceDate, 'now', {
    value: () => {
      const active = activeTimerContext();
      if (active === undefined) {
        return dateConstructor.now();
      }

      return active.context.mode === 'replay' ? replayDateNow(active) : recordDateNow(active);
    },
    writable: true,
    configurable: true
  });

  return ghosttraceDate as unknown as DateConstructor;
}

function installTimerPatches(): void {
  if (patchedSetTimeout === undefined) {
    originalSetTimeout = globalThis.setTimeout;
    patchedSetTimeout = function ghosttraceSetTimeout(...args: unknown[]): unknown {
      const active = activeTimerContext();
      if (active === undefined) {
        return callOriginalTimer(originalSetTimeout, args);
      }

      return active.context.mode === 'replay'
        ? replaySetTimer(active, 'setTimeout', args)
        : recordSetTimer(active, 'setTimeout', args, originalSetTimeout);
    } as typeof globalThis.setTimeout;
    globalThis.setTimeout = patchedSetTimeout;
  }

  if (patchedSetInterval === undefined) {
    originalSetInterval = globalThis.setInterval;
    patchedSetInterval = function ghosttraceSetInterval(...args: unknown[]): unknown {
      const active = activeTimerContext();
      if (active === undefined) {
        return callOriginalTimer(originalSetInterval, args);
      }

      return active.context.mode === 'replay'
        ? replaySetTimer(active, 'setInterval', args)
        : recordSetTimer(active, 'setInterval', args, originalSetInterval);
    } as typeof globalThis.setInterval;
    globalThis.setInterval = patchedSetInterval;
  }

  if (patchedClearTimeout === undefined) {
    originalClearTimeout = globalThis.clearTimeout;
    patchedClearTimeout = function ghosttraceClearTimeout(...args: unknown[]): unknown {
      const active = activeTimerContext();
      if (active === undefined) {
        return callOriginalTimer(originalClearTimeout, args);
      }

      return active.context.mode === 'replay'
        ? replayClearTimer(active, 'clearTimeout', args)
        : recordClearTimer(active, 'clearTimeout', args, originalClearTimeout);
    } as typeof globalThis.clearTimeout;
    globalThis.clearTimeout = patchedClearTimeout;
  }

  if (patchedClearInterval === undefined) {
    originalClearInterval = globalThis.clearInterval;
    patchedClearInterval = function ghosttraceClearInterval(...args: unknown[]): unknown {
      const active = activeTimerContext();
      if (active === undefined) {
        return callOriginalTimer(originalClearInterval, args);
      }

      return active.context.mode === 'replay'
        ? replayClearTimer(active, 'clearInterval', args)
        : recordClearTimer(active, 'clearInterval', args, originalClearInterval);
    } as typeof globalThis.clearInterval;
    globalThis.clearInterval = patchedClearInterval;
  }

  if (patchedDate === undefined) {
    originalDate = globalThis.Date;
    patchedDate = createPatchedDateConstructor(originalDate);
    globalThis.Date = patchedDate;
  }
}

function restoreTimerPatchesIfIdle(): void {
  if (activeTimerSessions.size > 0) {
    return;
  }

  if (patchedSetTimeout !== undefined && originalSetTimeout !== undefined && globalThis.setTimeout === patchedSetTimeout) {
    globalThis.setTimeout = originalSetTimeout;
  }
  if (patchedSetInterval !== undefined && originalSetInterval !== undefined && globalThis.setInterval === patchedSetInterval) {
    globalThis.setInterval = originalSetInterval;
  }
  if (patchedClearTimeout !== undefined && originalClearTimeout !== undefined && globalThis.clearTimeout === patchedClearTimeout) {
    globalThis.clearTimeout = originalClearTimeout;
  }
  if (patchedClearInterval !== undefined && originalClearInterval !== undefined && globalThis.clearInterval === patchedClearInterval) {
    globalThis.clearInterval = originalClearInterval;
  }
  if (patchedDate !== undefined && originalDate !== undefined && globalThis.Date === patchedDate) {
    globalThis.Date = originalDate;
  }

  originalSetTimeout = undefined;
  patchedSetTimeout = undefined;
  originalSetInterval = undefined;
  patchedSetInterval = undefined;
  originalClearTimeout = undefined;
  patchedClearTimeout = undefined;
  originalClearInterval = undefined;
  patchedClearInterval = undefined;
  originalDate = undefined;
  patchedDate = undefined;
}

function timerAvailable(): boolean {
  return (
    typeof globalThis.setTimeout === 'function' &&
    typeof globalThis.setInterval === 'function' &&
    typeof globalThis.clearTimeout === 'function' &&
    typeof globalThis.clearInterval === 'function' &&
    typeof globalThis.Date === 'function'
  );
}

/** Timer interceptor for timers and Date nondeterminism. */
export const timerInterceptor: Interceptor = {
  name: 'timer',
  install: (context: InterceptorContext): Teardown => {
    void markTimerInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return () => undefined;
    }

    activeTimerSessions.set(traceContext.traceId, {
      addSpan: context.addSpan,
      timerIds: new Map<unknown, string>(),
      nextTimerSequence: 1
    });
    installTimerPatches();

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }

      installed = false;
      activeTimerSessions.delete(traceContext.traceId);
      restoreTimerPatchesIfIdle();
    };
  },
  isAvailable: timerAvailable
};
