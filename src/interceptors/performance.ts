import { getTraceContext, type TraceContext } from '../core/context.js';
import { ReplayMismatchError } from '../core/errors.js';
import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanMetadata } from '../core/types.js';
import { isReplayStore, type ReplayStore } from '../replay/store.js';
import { isRecord, spanErrorFromUnknown } from './shared.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';

const PERFORMANCE_SENTINEL = '__GHOSTTRACE_PERFORMANCE_INTERCEPTOR_SENTINEL__';

type PerformanceMethodName = 'now' | 'mark' | 'measure';
type UnknownFunction = (...args: unknown[]) => unknown;

interface ActivePerformanceSession {
  readonly addSpan: (span: Span) => void;
}

interface ActivePerformanceContext {
  readonly context: TraceContext;
  readonly session: ActivePerformanceSession;
  readonly replayStore?: ReplayStore;
}

interface PerformancePatchState {
  readonly performance: Performance;
  readonly descriptors: ReadonlyMap<PerformanceMethodName, PropertyDescriptor | undefined>;
  readonly now: () => number;
  readonly mark: UnknownFunction;
  readonly measure: UnknownFunction;
  readonly patchedNow: Performance['now'];
  readonly patchedMark: Performance['mark'];
  readonly patchedMeasure: Performance['measure'];
}

const activePerformanceSessions = new Map<string, ActivePerformanceSession>();

let patchState: PerformancePatchState | undefined;

function markPerformanceInterceptorBundled(): string {
  return PERFORMANCE_SENTINEL;
}

function activePerformanceContext(): ActivePerformanceContext | undefined {
  const context = getTraceContext();

  if (context === undefined) {
    return undefined;
  }

  const session = activePerformanceSessions.get(context.traceId);
  if (session === undefined) {
    return undefined;
  }

  if (context.mode === 'replay') {
    const replayStore = isReplayStore(context.replayStore) ? context.replayStore : undefined;
    if (replayStore === undefined || !replayStore.canReplay(SpanType.Performance)) {
      return undefined;
    }

    return { context, session, replayStore };
  }

  return { context, session };
}

function recordWithOptionalValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function createPerformanceSpan(
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
    type: SpanType.Performance,
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

function addPerformanceSpan(
  active: ActivePerformanceContext,
  name: string,
  startTime: number,
  input: unknown,
  output: unknown,
  error: unknown,
  metadata: SpanMetadata
): void {
  active.session.addSpan(createPerformanceSpan(active.context, name, startTime, input, output, error, metadata));
}

function entrySnapshot(entry: PerformanceEntry): Readonly<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {
    name: entry.name,
    entryType: entry.entryType,
    startTime: entry.startTime,
    duration: entry.duration
  };
  const detail = (entry as { readonly detail?: unknown }).detail;

  recordWithOptionalValue(snapshot, 'detail', detail);
  return snapshot;
}

function markName(args: readonly unknown[]): string {
  const [name] = args;
  return typeof name === 'string' ? name : String(name);
}

function measureName(args: readonly unknown[]): string {
  const [name] = args;
  return typeof name === 'string' ? name : String(name);
}

function markInput(args: readonly unknown[]): Readonly<Record<string, unknown>> {
  const input: Record<string, unknown> = {
    operation: 'mark',
    markName: markName(args)
  };

  recordWithOptionalValue(input, 'options', args[1]);
  return input;
}

function measureInput(args: readonly unknown[]): Readonly<Record<string, unknown>> {
  const input: Record<string, unknown> = {
    operation: 'measure',
    measureName: measureName(args)
  };
  const startOrOptions = args[1];
  const endMark = args[2];

  if (typeof startOrOptions === 'string') {
    input.startMark = startOrOptions;
  } else {
    recordWithOptionalValue(input, 'options', startOrOptions);
  }
  if (typeof endMark === 'string') {
    input.endMark = endMark;
  }

  return input;
}

function recordPerformanceNow(active: ActivePerformanceContext): number {
  const input = { operation: 'now' };
  const startTime = active.context.clock.now();

  try {
    const value = patchState?.now() ?? performance.now();
    addPerformanceSpan(active, 'performance.now', startTime, input, value, null, {
      operation: 'now'
    });
    return value;
  } catch (error) {
    addPerformanceSpan(active, 'performance.now', startTime, input, undefined, error, {
      operation: 'now'
    });
    throw error;
  }
}

function numberFromSpanOutput(output: unknown, span: Span): number {
  if (typeof output === 'number') {
    return output;
  }

  throw new ReplayMismatchError(`Recorded performance span ${span.name} is missing numeric output`, {
    spanId: span.id,
    context: { output: span.output }
  });
}

function replayPerformanceNow(active: ActivePerformanceContext): number {
  const span = active.replayStore?.consumeSpan(SpanType.Performance, 'performance.now', { operation: 'now' })?.span;
  if (span === undefined) {
    return patchState?.now() ?? performance.now();
  }

  return numberFromSpanOutput(span.output, span);
}

function recordPerformanceMark(active: ActivePerformanceContext, args: readonly unknown[]): PerformanceMark {
  const input = markInput(args);
  const startTime = active.context.clock.now();

  try {
    const entry = Reflect.apply(patchState?.mark ?? performance.mark, performance, [...args]) as PerformanceMark;
    addPerformanceSpan(active, 'performance.mark', startTime, input, entrySnapshot(entry), null, {
      operation: 'mark',
      markName: input.markName
    });
    return entry;
  } catch (error) {
    addPerformanceSpan(active, 'performance.mark', startTime, input, undefined, error, {
      operation: 'mark',
      markName: input.markName
    });
    throw error;
  }
}

function stringFromRecord(output: unknown, key: string, span: Span): string {
  if (isRecord(output) && typeof output[key] === 'string') {
    return output[key];
  }

  throw new ReplayMismatchError(`Recorded performance span ${span.name} is missing string output.${key}`, {
    spanId: span.id,
    context: { output: span.output }
  });
}

function numberFromRecord(output: unknown, key: string, span: Span): number {
  if (isRecord(output) && typeof output[key] === 'number') {
    return output[key];
  }

  throw new ReplayMismatchError(`Recorded performance span ${span.name} is missing numeric output.${key}`, {
    spanId: span.id,
    context: { output: span.output }
  });
}

function entryFromSpan<TEntry extends PerformanceEntry>(span: Span): TEntry {
  const output = span.output;
  const name = stringFromRecord(output, 'name', span);
  const entryType = stringFromRecord(output, 'entryType', span);
  const startTime = numberFromRecord(output, 'startTime', span);
  const duration = numberFromRecord(output, 'duration', span);
  const detail = isRecord(output) ? output.detail : undefined;
  const entry = {
    name,
    entryType,
    startTime,
    duration,
    detail,
    toJSON(): Record<string, unknown> {
      return {
        name,
        entryType,
        startTime,
        duration,
        detail
      };
    }
  };

  return entry as unknown as TEntry;
}

function replayPerformanceMark(active: ActivePerformanceContext, args: readonly unknown[]): PerformanceMark {
  const input = markInput(args);
  const span = active.replayStore?.consumeSpan(SpanType.Performance, 'performance.mark', input)?.span;
  if (span === undefined) {
    return Reflect.apply(patchState?.mark ?? performance.mark, performance, [...args]) as PerformanceMark;
  }

  return entryFromSpan<PerformanceMark>(span);
}

function recordPerformanceMeasure(active: ActivePerformanceContext, args: readonly unknown[]): PerformanceMeasure {
  const input = measureInput(args);
  const startTime = active.context.clock.now();

  try {
    const entry = Reflect.apply(patchState?.measure ?? performance.measure, performance, [...args]) as PerformanceMeasure;
    addPerformanceSpan(active, 'performance.measure', startTime, input, entrySnapshot(entry), null, {
      operation: 'measure',
      measureName: input.measureName,
      startMark: input.startMark,
      endMark: input.endMark
    });
    return entry;
  } catch (error) {
    addPerformanceSpan(active, 'performance.measure', startTime, input, undefined, error, {
      operation: 'measure',
      measureName: input.measureName,
      startMark: input.startMark,
      endMark: input.endMark
    });
    throw error;
  }
}

function replayPerformanceMeasure(active: ActivePerformanceContext, args: readonly unknown[]): PerformanceMeasure {
  const input = measureInput(args);
  const span = active.replayStore?.consumeSpan(SpanType.Performance, 'performance.measure', input)?.span;
  if (span === undefined) {
    return Reflect.apply(patchState?.measure ?? performance.measure, performance, [...args]) as PerformanceMeasure;
  }

  return entryFromSpan<PerformanceMeasure>(span);
}

function methodDescriptor(performanceApi: Performance, method: PerformanceMethodName): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(performanceApi, method);
}

function definePerformanceMethod(
  performanceApi: Performance,
  method: PerformanceMethodName,
  value: unknown
): void {
  Object.defineProperty(performanceApi, method, {
    value,
    writable: true,
    configurable: true
  });
}

function installPerformancePatches(): void {
  if (patchState !== undefined) {
    return;
  }

  const performanceApi = globalThis.performance;
  const originalNow = performanceApi.now.bind(performanceApi);
  const originalMark = performanceApi.mark.bind(performanceApi) as UnknownFunction;
  const originalMeasure = performanceApi.measure.bind(performanceApi) as UnknownFunction;
  const patchedNow = function ghosttracePerformanceNow(): number {
    const active = activePerformanceContext();
    if (active === undefined) {
      return originalNow();
    }

    return active.context.mode === 'replay' ? replayPerformanceNow(active) : recordPerformanceNow(active);
  } as Performance['now'];
  const patchedMark = function ghosttracePerformanceMark(...args: unknown[]): PerformanceMark {
    const active = activePerformanceContext();
    if (active === undefined) {
      return Reflect.apply(originalMark, performanceApi, args) as PerformanceMark;
    }

    return active.context.mode === 'replay' ? replayPerformanceMark(active, args) : recordPerformanceMark(active, args);
  } as Performance['mark'];
  const patchedMeasure = function ghosttracePerformanceMeasure(...args: unknown[]): PerformanceMeasure {
    const active = activePerformanceContext();
    if (active === undefined) {
      return Reflect.apply(originalMeasure, performanceApi, args) as PerformanceMeasure;
    }

    return active.context.mode === 'replay'
      ? replayPerformanceMeasure(active, args)
      : recordPerformanceMeasure(active, args);
  } as Performance['measure'];

  patchState = {
    performance: performanceApi,
    descriptors: new Map<PerformanceMethodName, PropertyDescriptor | undefined>([
      ['now', methodDescriptor(performanceApi, 'now')],
      ['mark', methodDescriptor(performanceApi, 'mark')],
      ['measure', methodDescriptor(performanceApi, 'measure')]
    ]),
    now: originalNow,
    mark: originalMark,
    measure: originalMeasure,
    patchedNow,
    patchedMark,
    patchedMeasure
  };

  definePerformanceMethod(performanceApi, 'now', patchedNow);
  definePerformanceMethod(performanceApi, 'mark', patchedMark);
  definePerformanceMethod(performanceApi, 'measure', patchedMeasure);
}

function restorePerformanceMethod(
  performanceApi: Performance,
  method: PerformanceMethodName,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(performanceApi, method);
    return;
  }

  Object.defineProperty(performanceApi, method, descriptor);
}

function restorePerformancePatchesIfIdle(): void {
  if (activePerformanceSessions.size > 0 || patchState === undefined) {
    return;
  }

  restorePerformanceMethod(patchState.performance, 'now', patchState.descriptors.get('now'));
  restorePerformanceMethod(patchState.performance, 'mark', patchState.descriptors.get('mark'));
  restorePerformanceMethod(patchState.performance, 'measure', patchState.descriptors.get('measure'));
  patchState = undefined;
}

function performanceAvailable(): boolean {
  return (
    typeof globalThis.performance === 'object' &&
    globalThis.performance !== null &&
    typeof globalThis.performance.now === 'function' &&
    typeof globalThis.performance.mark === 'function' &&
    typeof globalThis.performance.measure === 'function'
  );
}

/** Performance API interceptor for performance.now(), mark(), and measure(). */
export const performanceInterceptor: Interceptor = {
  name: 'performance',
  install: (context: InterceptorContext): Teardown => {
    void markPerformanceInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return () => undefined;
    }

    activePerformanceSessions.set(traceContext.traceId, {
      addSpan: context.addSpan
    });
    installPerformancePatches();

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }

      installed = false;
      activePerformanceSessions.delete(traceContext.traceId);
      restorePerformancePatchesIfIdle();
    };
  },
  isAvailable: performanceAvailable
};
