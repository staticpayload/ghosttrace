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
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = options.code ?? 'GHOSTTRACE_ERROR';
    if (options.traceId !== undefined) {
      this.traceId = options.traceId;
    }
    if (options.spanId !== undefined) {
      this.spanId = options.spanId;
    }
    this.context = options.context ?? {};

    if (Error.captureStackTrace !== undefined) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

function withDefaultCode(options: GhostTraceErrorOptions, code: string): GhostTraceErrorOptions {
  return {
    ...options,
    code: options.code ?? code
  };
}

/** Error thrown or captured when recording cannot complete normally. */
export class RecordingError extends GhostTraceError {
  /** Creates a recording-specific GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_RECORDING_ERROR'));
  }
}

/** Error thrown when a replayed call does not match the recorded trace. */
export class ReplayMismatchError extends GhostTraceError {
  /** Creates a replay mismatch GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_REPLAY_MISMATCH'));
  }
}

/** Error thrown when replay consumes more calls than a trace contains. */
export class ReplayExhaustedError extends GhostTraceError {
  /** Creates a replay exhaustion GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_REPLAY_EXHAUSTED'));
  }
}

/** Error thrown when trace data fails schema or integrity validation. */
export class TraceValidationError extends GhostTraceError {
  /** Creates a trace validation GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_VALIDATION_ERROR'));
  }
}

/** Error thrown when a trace format version cannot be read by this library. */
export class TraceVersionError extends GhostTraceError {
  /** Creates a trace version GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_VERSION_ERROR'));
  }
}

/** Error thrown when secret redaction configuration or execution fails. */
export class RedactionError extends GhostTraceError {
  /** Creates a redaction-specific GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_REDACTION_ERROR'));
  }
}

/** Error thrown by explicit DB, queue, or framework adapters. */
export class AdapterError extends GhostTraceError {
  /** Creates an adapter-specific GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_ADAPTER_ERROR'));
  }
}

/** Error thrown when serialization or deserialization cannot complete. */
export class SerializationError extends GhostTraceError {
  /** Creates a serialization-specific GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_SERIALIZATION_ERROR'));
  }
}

/** Error thrown when writing or exporting a trace fails. */
export class ExportError extends GhostTraceError {
  /** Creates an export-specific GhostTrace error. */
  public constructor(message: string, options: GhostTraceErrorOptions = {}) {
    super(message, withDefaultCode(options, 'GHOSTTRACE_EXPORT_ERROR'));
  }
}
