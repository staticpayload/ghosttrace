import { getTraceContext, type TraceContext } from '../core/context.js';
import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanMetadata } from '../core/types.js';
import { isReplayStore, type ReplayStore } from '../replay/store.js';
import { isRecord, spanErrorFromUnknown } from './shared.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';

const ENV_SENTINEL = '__GHOSTTRACE_ENV_INTERCEPTOR_SENTINEL__';

interface ActiveEnvSession {
  readonly addSpan: (span: Span) => void;
  readonly shadowEnv: Map<string, string | undefined>;
}

interface ActiveEnvContext {
  readonly context: TraceContext;
  readonly session: ActiveEnvSession;
  readonly replayStore?: ReplayStore;
}

let originalEnv: NodeJS.ProcessEnv | undefined;
let patchedEnv: NodeJS.ProcessEnv | undefined;

const activeEnvSessions = new Map<string, ActiveEnvSession>();

function markEnvInterceptorBundled(): string {
  return ENV_SENTINEL;
}

function activeEnvContext(): ActiveEnvContext | undefined {
  const context = getTraceContext();

  if (context === undefined) {
    return undefined;
  }

  const session = activeEnvSessions.get(context.sessionId);
  if (session === undefined) {
    return undefined;
  }

  if (context.mode === 'replay') {
    const replayStore = isReplayStore(context.replayStore) ? context.replayStore : undefined;
    if (replayStore === undefined || !replayStore.canReplay(SpanType.Env)) {
      return undefined;
    }

    return { context, session, replayStore };
  }

  return { context, session };
}

function createEnvSpan(
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
    type: SpanType.Env,
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

function addEnvSpan(
  active: ActiveEnvContext,
  name: string,
  startTime: number,
  input: unknown,
  output: unknown,
  error: unknown,
  metadata: SpanMetadata
): void {
  active.session.addSpan(createEnvSpan(active.context, name, startTime, input, output, error, metadata));
}

function outputValue(output: unknown): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }

  return typeof output.value === 'string' ? output.value : undefined;
}

function propertyKey(property: string | symbol): string | undefined {
  return typeof property === 'string' ? property : undefined;
}

function envInput(operation: string, key: string, value?: unknown): Record<string, unknown> {
  const input: Record<string, unknown> = {
    operation,
    key
  };

  if (value !== undefined) {
    input.value = String(value);
  }

  return input;
}

function envMetadata(operation: string, key: string): SpanMetadata {
  return {
    operation,
    key
  };
}

function recordEnvGet(active: ActiveEnvContext, target: NodeJS.ProcessEnv, key: string): string | undefined {
  const startTime = active.context.clock.now();
  const input = envInput('get', key);
  const metadata = envMetadata('get', key);

  try {
    const value = target[key];
    addEnvSpan(active, 'process.env.get', startTime, input, { value, exists: value !== undefined }, null, metadata);
    return value;
  } catch (error) {
    addEnvSpan(active, 'process.env.get', startTime, input, undefined, error, metadata);
    throw error;
  }
}

function replayEnvGet(active: ActiveEnvContext, key: string): string | undefined {
  const span = active.replayStore?.consumeSpan(SpanType.Env, 'process.env.get', envInput('get', key))?.span;

  if (span === undefined) {
    return active.session.shadowEnv.has(key) ? active.session.shadowEnv.get(key) : originalEnv?.[key];
  }

  return outputValue(span.output);
}

function recordEnvSet(active: ActiveEnvContext, target: NodeJS.ProcessEnv, key: string, value: unknown): boolean {
  const startTime = active.context.clock.now();
  const input = envInput('set', key, value);
  const metadata = envMetadata('set', key);

  try {
    const success = Reflect.set(target, key, value);
    const storedValue = target[key];
    addEnvSpan(active, 'process.env.set', startTime, input, { success, value: storedValue }, null, metadata);
    return success;
  } catch (error) {
    addEnvSpan(active, 'process.env.set', startTime, input, undefined, error, metadata);
    throw error;
  }
}

function replayEnvSet(active: ActiveEnvContext, key: string, value: unknown): boolean {
  const span = active.replayStore?.consumeSpan(SpanType.Env, 'process.env.set', envInput('set', key, value))?.span;

  if (span !== undefined) {
    active.session.shadowEnv.set(key, outputValue(span.output));
    return true;
  }

  active.session.shadowEnv.set(key, String(value));
  return true;
}

function recordEnvDelete(active: ActiveEnvContext, target: NodeJS.ProcessEnv, key: string): boolean {
  const startTime = active.context.clock.now();
  const input = envInput('delete', key);
  const metadata = envMetadata('delete', key);
  const previousValue = target[key];
  const existed = Object.prototype.hasOwnProperty.call(target, key);

  try {
    const success = Reflect.deleteProperty(target, key);
    addEnvSpan(
      active,
      'process.env.delete',
      startTime,
      input,
      {
        success,
        existed,
        previousValue
      },
      null,
      metadata
    );
    return success;
  } catch (error) {
    addEnvSpan(active, 'process.env.delete', startTime, input, undefined, error, metadata);
    throw error;
  }
}

function replayEnvDelete(active: ActiveEnvContext, key: string): boolean {
  const span = active.replayStore?.consumeSpan(SpanType.Env, 'process.env.delete', envInput('delete', key))?.span;

  active.session.shadowEnv.delete(key);
  return span === undefined ? true : true;
}

function createEnvProxy(target: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return new Proxy(target, {
    get(envTarget, property, receiver) {
      const key = propertyKey(property);
      const active = key === undefined ? undefined : activeEnvContext();

      if (key === undefined || active === undefined) {
        return Reflect.get(envTarget, property, receiver);
      }

      return active.context.mode === 'replay' ? replayEnvGet(active, key) : recordEnvGet(active, envTarget, key);
    },
    set(envTarget, property, value) {
      const key = propertyKey(property);
      const active = key === undefined ? undefined : activeEnvContext();

      if (key === undefined || active === undefined) {
        return Reflect.set(envTarget, property, value);
      }

      return active.context.mode === 'replay' ? replayEnvSet(active, key, value) : recordEnvSet(active, envTarget, key, value);
    },
    deleteProperty(envTarget, property) {
      const key = propertyKey(property);
      const active = key === undefined ? undefined : activeEnvContext();

      if (key === undefined || active === undefined) {
        return Reflect.deleteProperty(envTarget, property);
      }

      return active.context.mode === 'replay' ? replayEnvDelete(active, key) : recordEnvDelete(active, envTarget, key);
    }
  });
}

function installEnvPatch(): void {
  if (patchedEnv !== undefined || typeof process === 'undefined') {
    return;
  }

  originalEnv = process.env;
  patchedEnv = createEnvProxy(originalEnv);
  process.env = patchedEnv;
}

function restoreEnvPatchIfIdle(): void {
  if (activeEnvSessions.size > 0 || patchedEnv === undefined) {
    return;
  }

  if (originalEnv !== undefined && process.env === patchedEnv) {
    process.env = originalEnv;
  }

  originalEnv = undefined;
  patchedEnv = undefined;
}

function envAvailable(): boolean {
  return typeof process !== 'undefined' && process.env !== undefined;
}

/** Environment interceptor for process.env reads, writes, and deletes. */
export const envInterceptor: Interceptor = {
  name: 'env',
  install: (context: InterceptorContext): Teardown => {
    void markEnvInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return () => undefined;
    }

    activeEnvSessions.set(traceContext.sessionId, {
      addSpan: context.addSpan,
      shadowEnv: new Map<string, string | undefined>()
    });
    installEnvPatch();

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }

      installed = false;
      activeEnvSessions.delete(traceContext.sessionId);
      restoreEnvPatchIfIdle();
    };
  },
  isAvailable: envAvailable
};
