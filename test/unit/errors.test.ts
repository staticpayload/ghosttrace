import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  ExportError,
  GhostTraceError,
  RecordingError,
  RedactionError,
  ReplayExhaustedError,
  ReplayMismatchError,
  SerializationError,
  TraceValidationError,
  TraceVersionError,
  type GhostTraceErrorOptions
} from '../../src/index.js';

type GhostTraceErrorConstructor = new (
  message: string,
  options?: GhostTraceErrorOptions
) => GhostTraceError;

const errorCases: readonly (readonly [GhostTraceErrorConstructor, string, string])[] = [
  [RecordingError, 'RecordingError', 'GHOSTTRACE_RECORDING_ERROR'],
  [ReplayMismatchError, 'ReplayMismatchError', 'GHOSTTRACE_REPLAY_MISMATCH'],
  [ReplayExhaustedError, 'ReplayExhaustedError', 'GHOSTTRACE_REPLAY_EXHAUSTED'],
  [TraceValidationError, 'TraceValidationError', 'GHOSTTRACE_VALIDATION_ERROR'],
  [TraceVersionError, 'TraceVersionError', 'GHOSTTRACE_VERSION_ERROR'],
  [RedactionError, 'RedactionError', 'GHOSTTRACE_REDACTION_ERROR'],
  [AdapterError, 'AdapterError', 'GHOSTTRACE_ADAPTER_ERROR'],
  [SerializationError, 'SerializationError', 'GHOSTTRACE_SERIALIZATION_ERROR'],
  [ExportError, 'ExportError', 'GHOSTTRACE_EXPORT_ERROR']
];

describe('GhostTrace error hierarchy', () => {
  it.each(errorCases)('%s extends GhostTraceError with name, cause, metadata, and stack', (
    ErrorClass,
    expectedName,
    expectedCode
  ) => {
    const cause = new Error('root cause');
    const error = new ErrorClass('outer failure', {
      cause,
      traceId: 'trace_0001',
      spanId: 'span_0001',
      context: { operation: 'unit-test' }
    });

    expect(error).toBeInstanceOf(GhostTraceError);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.name).toBe(expectedName);
    expect(error.code).toBe(expectedCode);
    expect(error.cause).toBe(cause);
    expect(error.traceId).toBe('trace_0001');
    expect(error.spanId).toBe('span_0001');
    expect(error.context).toEqual({ operation: 'unit-test' });
    expect(error.stack).toEqual(expect.any(String));
    expect(error.stack).toContain('outer failure');
  });

  it('allows callers to override the default code while preserving subclass identity', () => {
    const error = new RecordingError('custom code', { code: 'CUSTOM_RECORDING_CODE' });

    expect(error).toBeInstanceOf(GhostTraceError);
    expect(error).toBeInstanceOf(RecordingError);
    expect(error.name).toBe('RecordingError');
    expect(error.code).toBe('CUSTOM_RECORDING_CODE');
  });
});
