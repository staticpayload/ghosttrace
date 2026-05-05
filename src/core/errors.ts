import type { TraceMetadata } from './types.js';

/** Options accepted by GhostTraceError and subclasses. */
export interface GhostTraceErrorOptions {
  /** Machine-readable error code. */
  readonly code?: string;
  /** Trace identifier associated with the failure. */
  readonly traceId?: string;
  /** Span identifier associated with the failure. */
  readonly spanId?: string;
  /** Structured diagnostic context. */
  readonly context?: TraceMetadata;
  /** Underlying cause, when available. */
  readonly cause?: unknown;
}

/** Base class for all GhostTrace-specific errors. */
export class GhostTraceError extends Error {
  /** Machine-readable error code. */
  public readonly code: string;
  /** Trace identifier associated with the failure, when known. */
  public readonly traceId?: string;
  /** Span identifier associated with the failure, when known. */
  public readonly spanId?: string;
  /** Structured diagnostic context. */
  public readonly context: TraceMetadata;

  /** Creates a GhostTrace error with serializable metadata. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'GHOSTTRACE_ERROR';
    if (options.traceId !== undefined) {
      this.traceId = options.traceId;
    }
    if (options.spanId !== undefined) {
      this.spanId = options.spanId;
    }
    this.context = options.context ?? {};
  }
}
