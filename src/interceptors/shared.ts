import type { SpanError } from '../core/types.js';

interface MutableSpanError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SpanError;
}

/** Converts an unknown thrown value into serializable span error details. */
export function spanErrorFromUnknown(error: unknown): SpanError {
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

/** Type guard for plain record-like values emitted in span payloads. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
