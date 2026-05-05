import { getTraceContext, runWithSpanContext, type TraceContext } from '../core/context.js';
import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanMetadata } from '../core/types.js';
import { spanErrorFromUnknown } from './shared.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';
import { noopTeardown } from './types.js';

const QUEUE_SENTINEL = '__GHOSTTRACE_QUEUE_INTERCEPTOR_SENTINEL__';

type ClientMethodKey<TClient extends object> = Extract<keyof TClient, string>;
type ClientMethod = (...args: unknown[]) => unknown;

/** Extracts a queue name from method arguments and/or result. */
export type QueueNameExtractor = (args: readonly unknown[], result: unknown) => string | undefined;

/** Extracts a queue message identifier from method arguments and/or result. */
export type QueueMessageIdExtractor = (args: readonly unknown[], result: unknown) => string | undefined;

/** Extracts a queue payload from method arguments and/or result. */
export type QueuePayloadExtractor = (args: readonly unknown[], result: unknown) => unknown;

/** Describes one queue operation method on a queue client. */
export interface QueueOperationDescriptor<TClient extends object> {
  /** Method name on the wrapped client. */
  readonly method: ClientMethodKey<TClient>;
  /** Queue operation label such as send, receive, ack, or nack. */
  readonly operation: 'send' | 'receive' | 'ack' | 'nack' | string;
  /** Extracts the queue name. Defaults to the first argument when it is a string. */
  readonly queueName?: QueueNameExtractor;
  /** Extracts the message identifier. */
  readonly messageId?: QueueMessageIdExtractor;
  /** Extracts the message payload. */
  readonly payload?: QueuePayloadExtractor;
}

/** Adapter describing how to observe an arbitrary queue client. */
export interface QueueAdapter<TClient extends object> {
  /** Human-readable adapter name stored in span metadata. */
  readonly name: string;
  /** Queue methods to wrap and record. */
  readonly operations: readonly QueueOperationDescriptor<TClient>[];
}

interface ActiveQueueSession {
  readonly addSpan: (span: Span) => void;
}

interface ActiveQueueContext {
  readonly context: TraceContext;
  readonly session: ActiveQueueSession;
}

interface QueueInvocationMetadata {
  readonly input: Readonly<Record<string, unknown>>;
  readonly metadata: SpanMetadata;
  readonly name: string;
}

const activeQueueSessions = new Map<string, ActiveQueueSession>();

function markQueueInterceptorBundled(): string {
  return QUEUE_SENTINEL;
}

function activeQueueContext(): ActiveQueueContext | undefined {
  const context = getTraceContext();

  if (context === undefined || context.mode !== 'record') {
    return undefined;
  }

  const session = activeQueueSessions.get(context.traceId);
  if (session === undefined) {
    return undefined;
  }

  return { context, session };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }

  return typeof (value as { readonly then?: unknown }).then === 'function';
}

function isClientMethod(value: unknown): value is ClientMethod {
  return typeof value === 'function';
}

function defaultQueueName(args: readonly unknown[]): string | undefined {
  const [queueName] = args;
  return typeof queueName === 'string' ? queueName : undefined;
}

function messageIdFromResult(result: unknown): string | undefined {
  if (typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string') {
    return result.id;
  }

  if (typeof result === 'object' && result !== null && 'messageId' in result && typeof result.messageId === 'string') {
    return result.messageId;
  }

  return undefined;
}

function recordWithOptionalValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function createPendingQueueSpan(
  context: TraceContext,
  name: string,
  startTime: number,
  input: Readonly<Record<string, unknown>>,
  metadata: SpanMetadata
): Span {
  return {
    id: context.idGenerator.next(),
    parentId: context.currentSpan?.id ?? null,
    type: SpanType.Queue,
    name,
    startTime,
    endTime: startTime,
    duration: 0,
    input: serialize(input),
    output: serialize(undefined),
    children: [],
    error: null,
    metadata
  };
}

function completeQueueSpan(context: TraceContext, span: Span, output: unknown, error: unknown): Span {
  const endTime = context.clock.now();

  return {
    ...span,
    endTime,
    duration: endTime - span.startTime,
    output: serialize(output),
    children: [],
    error: error === null ? null : spanErrorFromUnknown(error)
  };
}

function queueNameForDescriptor<TClient extends object>(
  descriptor: QueueOperationDescriptor<TClient>,
  args: readonly unknown[],
  result: unknown
): string | undefined {
  return descriptor.queueName === undefined ? defaultQueueName(args) : descriptor.queueName(args, result);
}

function messageIdForDescriptor<TClient extends object>(
  descriptor: QueueOperationDescriptor<TClient>,
  args: readonly unknown[],
  result: unknown
): string | undefined {
  if (descriptor.messageId !== undefined) {
    return descriptor.messageId(args, result);
  }

  return messageIdFromResult(result);
}

function payloadForDescriptor<TClient extends object>(
  descriptor: QueueOperationDescriptor<TClient>,
  args: readonly unknown[],
  result: unknown
): unknown {
  if (descriptor.payload !== undefined) {
    return descriptor.payload(args, result);
  }

  if (typeof result === 'object' && result !== null && 'payload' in result) {
    return result.payload;
  }

  return undefined;
}

function queueInvocationMetadata<TClient extends object>(
  adapter: QueueAdapter<TClient>,
  descriptor: QueueOperationDescriptor<TClient>,
  args: readonly unknown[]
): QueueInvocationMetadata {
  const queueName = queueNameForDescriptor(descriptor, args, undefined);
  const messageId = messageIdForDescriptor(descriptor, args, undefined);
  const payload = payloadForDescriptor(descriptor, args, undefined);
  const input: Record<string, unknown> = {
    adapter: adapter.name,
    operation: descriptor.operation
  };
  const metadata: Record<string, unknown> = {
    adapter: adapter.name,
    operation: descriptor.operation,
    method: descriptor.method
  };

  recordWithOptionalValue(input, 'queueName', queueName);
  recordWithOptionalValue(input, 'messageId', messageId);
  recordWithOptionalValue(input, 'payload', payload);
  recordWithOptionalValue(metadata, 'queueName', queueName);
  recordWithOptionalValue(metadata, 'messageId', messageId);

  return {
    input,
    metadata,
    name: `queue.${descriptor.method}`
  };
}

function queueOutput<TClient extends object>(
  descriptor: QueueOperationDescriptor<TClient>,
  args: readonly unknown[],
  result: unknown
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {
    result
  };
  const messageId = messageIdForDescriptor(descriptor, args, result);
  const payload = descriptor.operation === 'receive' ? payloadForDescriptor(descriptor, args, result) : undefined;

  recordWithOptionalValue(output, 'messageId', messageId);
  recordWithOptionalValue(output, 'payload', payload);
  return output;
}

function completeInvocation(active: ActiveQueueContext, span: Span, output: unknown, error: unknown): void {
  active.session.addSpan(completeQueueSpan(active.context, span, output, error));
}

function invokeRecordedQueueMethod(
  active: ActiveQueueContext,
  targetMethod: ClientMethod,
  thisArg: unknown,
  args: readonly unknown[],
  metadata: QueueInvocationMetadata,
  outputForResult: (result: unknown) => unknown
): unknown {
  const span = createPendingQueueSpan(active.context, metadata.name, active.context.clock.now(), metadata.input, metadata.metadata);

  try {
    const result = runWithSpanContext(span, () => Reflect.apply(targetMethod, thisArg, [...args]));

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(
        (resolved) => {
          completeInvocation(active, span, outputForResult(resolved), null);
          return resolved;
        },
        (error: unknown) => {
          completeInvocation(active, span, undefined, error);
          throw error;
        }
      );
    }

    completeInvocation(active, span, outputForResult(result), null);
    return result;
  } catch (error) {
    completeInvocation(active, span, undefined, error);
    throw error;
  }
}

function operationMap<TClient extends object>(
  adapter: QueueAdapter<TClient>
): ReadonlyMap<string, QueueOperationDescriptor<TClient>> {
  return new Map(adapter.operations.map((descriptor) => [descriptor.method, descriptor]));
}

/** Wraps a queue client so configured methods emit queue spans during active recordings. */
export function wrapQueue<TClient extends object>(client: TClient, adapter: QueueAdapter<TClient>): TClient {
  const operations = operationMap(adapter);

  return new Proxy(client, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !isClientMethod(value)) {
        return value;
      }

      const descriptor = operations.get(property);
      if (descriptor === undefined) {
        return value;
      }

      return function ghosttraceQueueMethod(this: unknown, ...args: unknown[]): unknown {
        const thisArg = this === receiver ? target : this;
        const active = activeQueueContext();

        if (active === undefined) {
          return Reflect.apply(value, thisArg, args);
        }

        const metadata = queueInvocationMetadata(adapter, descriptor, args);
        return invokeRecordedQueueMethod(active, value, thisArg, args, metadata, (result) =>
          queueOutput(descriptor, args, result)
        );
      };
    }
  });
}

/** Queue adapter interceptor enabling wrapQueue() spans during recording. */
export const queueInterceptor: Interceptor = {
  name: 'queue',
  install: (context: InterceptorContext): Teardown => {
    void markQueueInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return noopTeardown;
    }

    activeQueueSessions.set(traceContext.traceId, {
      addSpan: context.addSpan
    });

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }

      installed = false;
      activeQueueSessions.delete(traceContext.traceId);
    };
  },
  isAvailable: (): boolean => true
};
