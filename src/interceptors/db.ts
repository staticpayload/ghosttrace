import { getTraceContext, runWithSpanContext, type TraceContext } from '../core/context.js';
import { serialize } from '../core/serializer.js';
import { SpanType, type Span, type SpanMetadata } from '../core/types.js';
import { spanErrorFromUnknown } from './shared.js';
import type { Interceptor, InterceptorContext, Teardown } from './types.js';
import { noopTeardown } from './types.js';

const DB_SENTINEL = '__GHOSTTRACE_DB_INTERCEPTOR_SENTINEL__';

type ClientMethodKey<TClient extends object> = Extract<keyof TClient, string>;
type ClientMethod = (...args: unknown[]) => unknown;

/** Extracts query metadata from DB method arguments. */
export type DbQueryExtractor = (args: readonly unknown[]) => unknown;

/** Extracts DB method parameters from DB method arguments. */
export type DbParamsExtractor = (args: readonly unknown[]) => unknown;

/** Extracts the recorded result payload from a DB method result. */
export type DbResultExtractor = (result: unknown, args: readonly unknown[]) => unknown;

/** Extracts the affected row count from a DB method result. */
export type DbRowCountExtractor = (result: unknown, args: readonly unknown[]) => number | undefined;

/** Extracts a transaction identifier from DB method arguments and/or result. */
export type DbTransactionIdExtractor = (args: readonly unknown[], result: unknown) => string | undefined;

/** Describes one query-like method on a DB client. */
export interface DbOperationDescriptor<TClient extends object> {
  /** Method name on the wrapped client. */
  readonly method: ClientMethodKey<TClient>;
  /** Operation label, or a function deriving it from arguments. Defaults to the first SQL verb. */
  readonly operation?: string | ((args: readonly unknown[]) => string);
  /** Extracts the query or command text. Defaults to the first argument. */
  readonly query?: DbQueryExtractor;
  /** Extracts query parameters. Defaults to the second argument. */
  readonly params?: DbParamsExtractor;
  /** Extracts the result payload to record. Defaults to the full returned value. */
  readonly result?: DbResultExtractor;
  /** Extracts affected row count. Defaults to a numeric result.rowCount property when present. */
  readonly rowCount?: DbRowCountExtractor;
}

/** Describes one transaction boundary method on a DB client. */
export interface DbTransactionDescriptor<TClient extends object> {
  /** Method name on the wrapped client. */
  readonly method: ClientMethodKey<TClient>;
  /** Transaction operation label such as begin, commit, or rollback. */
  readonly operation: 'begin' | 'commit' | 'rollback' | string;
  /** Extracts a transaction identifier from arguments and/or result. */
  readonly transactionId?: DbTransactionIdExtractor;
}

/** Adapter describing how to observe an arbitrary DB client. */
export interface DbAdapter<TClient extends object> {
  /** Human-readable adapter name stored in span metadata. */
  readonly name: string;
  /** Query-like methods to wrap and record. */
  readonly operations: readonly DbOperationDescriptor<TClient>[];
  /** Transaction boundary methods to wrap and record. */
  readonly transactions?: readonly DbTransactionDescriptor<TClient>[];
}

interface ActiveDbSession {
  readonly addSpan: (span: Span) => void;
}

interface ActiveDbContext {
  readonly context: TraceContext;
  readonly session: ActiveDbSession;
}

interface DbInvocationMetadata {
  readonly input: Readonly<Record<string, unknown>>;
  readonly metadata: SpanMetadata;
  readonly name: string;
}

const activeDbSessions = new Map<string, ActiveDbSession>();

function markDbInterceptorBundled(): string {
  return DB_SENTINEL;
}

function activeDbContext(): ActiveDbContext | undefined {
  const context = getTraceContext();

  if (context === undefined || context.mode !== 'record') {
    return undefined;
  }

  const session = activeDbSessions.get(context.traceId);
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

function inferOperationFromQuery(query: unknown): string {
  if (typeof query !== 'string') {
    return 'QUERY';
  }

  const operation = query.trim().match(/^[A-Za-z]+/u)?.[0]?.toUpperCase();
  if (operation === undefined || operation.length === 0) {
    return 'QUERY';
  }

  return operation;
}

function operationForDescriptor<TClient extends object>(
  descriptor: DbOperationDescriptor<TClient>,
  args: readonly unknown[],
  query: unknown
): string {
  if (typeof descriptor.operation === 'function') {
    const operation = descriptor.operation(args).trim();
    return operation.length === 0 ? inferOperationFromQuery(query) : operation;
  }

  if (typeof descriptor.operation === 'string' && descriptor.operation.trim().length > 0) {
    return descriptor.operation.trim();
  }

  return inferOperationFromQuery(query);
}

function defaultQuery(args: readonly unknown[]): unknown {
  return args[0];
}

function defaultParams(args: readonly unknown[]): unknown {
  return args[1];
}

function rowCountFromResult(result: unknown): number | undefined {
  if (
    typeof result === 'object' &&
    result !== null &&
    'rowCount' in result &&
    typeof result.rowCount === 'number'
  ) {
    return result.rowCount;
  }

  return undefined;
}

function recordWithOptionalValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function createPendingDbSpan(
  context: TraceContext,
  name: string,
  startTime: number,
  input: Readonly<Record<string, unknown>>,
  metadata: SpanMetadata
): Span {
  return {
    id: context.idGenerator.next(),
    parentId: context.currentSpan?.id ?? null,
    type: SpanType.Db,
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

function completeDbSpan(context: TraceContext, span: Span, output: unknown, error: unknown): Span {
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

function queryInvocationMetadata<TClient extends object>(
  adapter: DbAdapter<TClient>,
  descriptor: DbOperationDescriptor<TClient>,
  args: readonly unknown[]
): DbInvocationMetadata {
  const query = (descriptor.query ?? defaultQuery)(args);
  const params = (descriptor.params ?? defaultParams)(args);
  const operation = operationForDescriptor(descriptor, args, query);
  const input: Record<string, unknown> = {
    adapter: adapter.name,
    operation
  };
  const metadata: Record<string, unknown> = {
    adapter: adapter.name,
    operation,
    method: descriptor.method
  };

  recordWithOptionalValue(input, 'query', query);
  recordWithOptionalValue(input, 'params', params);
  recordWithOptionalValue(metadata, 'query', query);

  return {
    input,
    metadata,
    name: `db.${descriptor.method}`
  };
}

function queryOutput<TClient extends object>(
  descriptor: DbOperationDescriptor<TClient>,
  args: readonly unknown[],
  result: unknown
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {
    result: descriptor.result === undefined ? result : descriptor.result(result, args)
  };
  const rowCount = descriptor.rowCount === undefined ? rowCountFromResult(result) : descriptor.rowCount(result, args);

  recordWithOptionalValue(output, 'rowCount', rowCount);
  return output;
}

function transactionIdFromDescriptor<TClient extends object>(
  descriptor: DbTransactionDescriptor<TClient>,
  args: readonly unknown[],
  result: unknown
): string | undefined {
  if (descriptor.transactionId !== undefined) {
    return descriptor.transactionId(args, result);
  }

  const firstArg = args[0];
  return typeof firstArg === 'string' ? firstArg : undefined;
}

function transactionInvocationMetadata<TClient extends object>(
  adapter: DbAdapter<TClient>,
  descriptor: DbTransactionDescriptor<TClient>,
  args: readonly unknown[]
): DbInvocationMetadata {
  const transactionId = transactionIdFromDescriptor(descriptor, args, undefined);
  const input: Record<string, unknown> = {
    adapter: adapter.name,
    operation: descriptor.operation
  };
  const metadata: Record<string, unknown> = {
    adapter: adapter.name,
    operation: descriptor.operation,
    method: descriptor.method
  };

  recordWithOptionalValue(input, 'transactionId', transactionId);
  recordWithOptionalValue(metadata, 'transactionId', transactionId);

  return {
    input,
    metadata,
    name: `db.${descriptor.method}`
  };
}

function transactionOutput<TClient extends object>(
  descriptor: DbTransactionDescriptor<TClient>,
  args: readonly unknown[],
  result: unknown
): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {
    result
  };
  const transactionId = transactionIdFromDescriptor(descriptor, args, result);

  recordWithOptionalValue(output, 'transactionId', transactionId);
  return output;
}

function completeInvocation(
  active: ActiveDbContext,
  span: Span,
  output: unknown,
  error: unknown
): void {
  active.session.addSpan(completeDbSpan(active.context, span, output, error));
}

function invokeRecordedDbMethod(
  active: ActiveDbContext,
  targetMethod: ClientMethod,
  thisArg: unknown,
  args: readonly unknown[],
  metadata: DbInvocationMetadata,
  outputForResult: (result: unknown) => unknown
): unknown {
  const span = createPendingDbSpan(active.context, metadata.name, active.context.clock.now(), metadata.input, metadata.metadata);

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

function descriptorMaps<TClient extends object>(
  adapter: DbAdapter<TClient>
): {
  readonly operations: ReadonlyMap<string, DbOperationDescriptor<TClient>>;
  readonly transactions: ReadonlyMap<string, DbTransactionDescriptor<TClient>>;
} {
  return {
    operations: new Map(adapter.operations.map((descriptor) => [descriptor.method, descriptor])),
    transactions: new Map((adapter.transactions ?? []).map((descriptor) => [descriptor.method, descriptor]))
  };
}

/** Wraps a DB client so configured methods emit DB spans during active recordings. */
export function wrapDb<TClient extends object>(client: TClient, adapter: DbAdapter<TClient>): TClient {
  const maps = descriptorMaps(adapter);

  return new Proxy(client, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !isClientMethod(value)) {
        return value;
      }

      const operationDescriptor = maps.operations.get(property);
      const transactionDescriptor = maps.transactions.get(property);
      if (operationDescriptor === undefined && transactionDescriptor === undefined) {
        return value;
      }

      return function ghosttraceDbMethod(this: unknown, ...args: unknown[]): unknown {
        const thisArg = this === receiver ? target : this;
        const active = activeDbContext();

        if (active === undefined) {
          return Reflect.apply(value, thisArg, args);
        }

        if (operationDescriptor !== undefined) {
          const metadata = queryInvocationMetadata(adapter, operationDescriptor, args);
          return invokeRecordedDbMethod(active, value, thisArg, args, metadata, (result) =>
            queryOutput(operationDescriptor, args, result)
          );
        }

        if (transactionDescriptor !== undefined) {
          const metadata = transactionInvocationMetadata(adapter, transactionDescriptor, args);
          return invokeRecordedDbMethod(active, value, thisArg, args, metadata, (result) =>
            transactionOutput(transactionDescriptor, args, result)
          );
        }

        return Reflect.apply(value, thisArg, args);
      };
    }
  });
}

/** DB adapter interceptor enabling wrapDb() spans during recording. */
export const dbInterceptor: Interceptor = {
  name: 'db',
  install: (context: InterceptorContext): Teardown => {
    void markDbInterceptorBundled();
    const traceContext = getTraceContext();

    if (traceContext === undefined) {
      return noopTeardown;
    }

    activeDbSessions.set(traceContext.traceId, {
      addSpan: context.addSpan
    });

    let installed = true;

    return () => {
      if (!installed) {
        return;
      }

      installed = false;
      activeDbSessions.delete(traceContext.traceId);
    };
  },
  isAvailable: (): boolean => true
};
