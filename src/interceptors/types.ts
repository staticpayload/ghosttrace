import type { Span } from '../core/types.js';

/** Function that restores monkey patches or other interceptor state. */
export type Teardown = () => void;

/** Context provided to stateless interceptor modules when installed. */
export interface InterceptorContext {
  /** Adds a span to the active trace. */
  readonly addSpan: (span: Span) => void;
}

/** Stateless module capable of observing one class of side effect. */
export interface Interceptor {
  /** Stable interceptor name used in configuration. */
  readonly name: string;
  /** Installs the interceptor and returns a teardown function. */
  readonly install: (context: InterceptorContext) => Teardown;
  /** Reports whether this interceptor can run in the current runtime. */
  readonly isAvailable: () => boolean;
}

/** No-op teardown shared by placeholder foundation interceptors. */
export function noopTeardown(): void {
  return undefined;
}
