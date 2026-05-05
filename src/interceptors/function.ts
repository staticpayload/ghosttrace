import { getTraceContext, runWithSpanContext, type TraceContext } from '../core/context.js';
import { serialize, type SerializedJsonValue } from '../core/serializer.js';
import { SpanType, type Span, type SpanError } from '../core/types.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';
import { noopTeardown } from './types.js';

const FUNCTION_SENTINEL = '__GHOSTTRACE_FUNCTION_INTERCEPTOR_SENTINEL__';

type WrappableFunction = (...args: never[]) => unknown;

interface ActiveFunctionSession {
  readonly addSpan: (span: Span) => void;
}

interface ActiveFunctionContext {
  readonly context: TraceContext;
  readonly session: ActiveFunctionSession;
}

interface MutableSpanError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SpanError;
}

const activeFunctionSessions = new Map<string, ActiveFunctionSession>();
const wrappedFunctionProxies = new WeakSet<object>();

function markFunctionInterceptorBundled(): string {
  return FUNCTION_SENTINEL;
}

function spanErrorFromUnknown(error: unknown): SpanError {
  if (error instanceof Error) {
    const errorRecord = error as Error & {
      readonly cause?: unknown;
      readonly code?: unknown;
    };
    const spanError: MutableSpanError = {
      name: error.name,
      message: error.message
    };

    if (error.stack !== undefined) {
      spanError.stack = error.stack;
    }
    if (typeof errorRecord.code === 'string') {
      spanError.code = errorRecord.code;
    }
    if (errorRecord.cause !== undefined) {
      spanError.cause = spanErrorFromUnknown(errorRecord.cause);
    }

    return spanError;
  }

  return {
    name: error === null ? 'null' : typeof error,
    message: String(error)
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }

  const then = (value as { readonly then?: unknown }).then;
  return typeof then === 'function';
}

function functionName(fn: WrappableFunction, nameHint: PropertyKey | undefined): string {
  if (fn.name.length > 0) {
    return fn.name;
  }

  if (typeof nameHint === 'symbol') {
    return nameHint.description ?? '<anonymous>';
  }

  return nameHint === undefined ? '<anonymous>' : String(nameHint);
}

function activeFunctionContext(): ActiveFunctionContext | undefined {
  const context = getTraceContext();

  if (context === undefined || context.mode !== 'record') {
    return undefined;
  }

  const session = activeFunctionSessions.get(context.traceId);
  if (session === undefined) {
    return undefined;
  }

  return { context, session };
}

function serializeArguments(args: readonly unknown[]): readonly SerializedJsonValue[] {
  return args.map((arg) => serialize(arg));
}

function pendingFunctionSpan(context: TraceContext, name: string, args: readonly unknown[]): Span {
  const startTime = context.clock.now();

  return {
    id: context.idGenerator.next(),
    parentId: context.currentSpan?.id ?? null,
    type: SpanType.Function,
    name,
    startTime,
    endTime: startTime,
    duration: 0,
    input: serializeArguments(args),
    output: serialize(undefined),
    children: [],
    error: null,
    metadata: {}
  };
}

function completeFunctionSpan(
  context: TraceContext,
  span: Span,
  output: unknown,
  error: SpanError | null,
  isAsync: boolean
): Span {
  const endTime = context.clock.now();

  return {
    ...span,
    endTime,
    duration: endTime - span.startTime,
    output: serialize(output),
    children: [],
    error,
    metadata: {
      ...span.metadata,
      isAsync
    }
  };
}

function invokeWrappedFunction(
  context: TraceContext,
  session: ActiveFunctionSession,
  target: WrappableFunction,
  thisArg: unknown,
  args: readonly unknown[],
  name: string
): unknown {
  const span = pendingFunctionSpan(context, name, args);

  try {
    const output = runWithSpanContext(span, () => Reflect.apply(target, thisArg, args));

    if (isPromiseLike(output)) {
      return Promise.resolve(output).then(
        (resolvedOutput) => {
          session.addSpan(completeFunctionSpan(context, span, resolvedOutput, null, true));
          return resolvedOutput;
        },
        (error: unknown) => {
          session.addSpan(completeFunctionSpan(context, span, undefined, spanErrorFromUnknown(error), true));
          throw error;
        }
      );
    }

    session.addSpan(completeFunctionSpan(context, span, output, null, false));
    return output;
  } catch (error) {
    session.addSpan(completeFunctionSpan(context, span, undefined, spanErrorFromUnknown(error), false));
    throw error;
  }
}

function wrapFunction<TFunction extends WrappableFunction>(fn: TFunction, nameHint?: PropertyKey): TFunction {
  if (wrappedFunctionProxies.has(fn)) {
    return fn;
  }

  const name = functionName(fn, nameHint);
  const proxy = new Proxy(fn, {
    apply: (target, thisArg, args) => {
      const active = activeFunctionContext();

      if (active === undefined) {
        return Reflect.apply(target, thisArg, args);
      }

      return invokeWrappedFunction(active.context, active.session, target, thisArg, args, name);
    }
  });

  wrappedFunctionProxies.add(proxy);
  return proxy;
}

/** Wraps a function so calls inside active recordings produce function spans. */
export function wrap<TFunction extends WrappableFunction>(fn: TFunction): TFunction {
  return wrapFunction(fn);
}

/** Wraps every function-valued export on a module object while preserving non-function exports. */
export function wrapModule<TModule extends object>(moduleExports: TModule): TModule {
  const wrappedModule = Object.create(Object.getPrototypeOf(moduleExports)) as TModule;

  for (const key of Reflect.ownKeys(moduleExports)) {
    const descriptor = Object.getOwnPropertyDescriptor(moduleExports, key);

    if (descriptor === undefined) {
      continue;
    }

    const wrappedDescriptor =
      'value' in descriptor && typeof descriptor.value === 'function'
        ? {
            ...descriptor,
            value: wrapFunction(descriptor.value, key)
          }
        : descriptor;

    Object.defineProperty(wrappedModule, key, wrappedDescriptor);
  }

  return wrappedModule;
}

/** Function interceptor that records calls made through wrap() and wrapModule(). */
export const functionInterceptor: Interceptor = {
  name: 'function',
  install: (context: InterceptorContext): Teardown => {
    void markFunctionInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return noopTeardown;
    }

    activeFunctionSessions.set(traceContext.traceId, {
      addSpan: context.addSpan
    });

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }

      installed = false;
      activeFunctionSessions.delete(traceContext.traceId);
    };
  },
  isAvailable: (): boolean => true
};
