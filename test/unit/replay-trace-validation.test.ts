import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpanType, TraceValidationError, ghost } from '../../src/index.js';

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/replay-trace-validation/${name}`, import.meta.url));
}

async function replayFixtureError(name: string): Promise<unknown> {
  try {
    await ghost.replay(fixturePath(name), () => 'should-not-run');
  } catch (error) {
    return error;
  }

  throw new Error(`Expected fixture ${name} to fail replay trace validation`);
}

function expectTraceValidationMessages(error: unknown, expectedMessages: readonly string[]): void {
  expect(error).toBeInstanceOf(TraceValidationError);
  expect(error).toMatchObject({
    name: TraceValidationError.name,
    code: 'GHOSTTRACE_REPLAY_TRACE_INVALID'
  });

  const validationError = error as TraceValidationError;
  for (const expectedMessage of expectedMessages) {
    expect(validationError.message).toContain(expectedMessage);
  }
}

describe('replay trace loading validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects corrupted fixtures with invalid SpanType values during loading', async () => {
    const error = await replayFixtureError('invalid-span-type.ghosttrace.json');

    expectTraceValidationMessages(error, [
      `trace.spans[0].type must be one of: ${Object.values(SpanType).join(', ')}`
    ]);
  });

  it('rejects corrupted fixtures with missing required span fields descriptively', async () => {
    const error = await replayFixtureError('missing-required-fields.ghosttrace.json');

    expectTraceValidationMessages(error, [
      'trace.spans[0].name is required',
      'trace.spans[0].input is required',
      'trace.spans[0].output is required'
    ]);
  });

  it('rejects corrupted fixtures with invalid replay outcome output.type values during loading', async () => {
    const error = await replayFixtureError('invalid-output-type.ghosttrace.json');

    expectTraceValidationMessages(error, [
      'trace.spans[0].output.type must be one of: resolve, reject, return, throw'
    ]);
  });

  it('rejects corrupted fixtures with dangling parentId references during loading', async () => {
    const error = await replayFixtureError('dangling-parent-id.ghosttrace.json');

    expectTraceValidationMessages(error, [
      'trace.spans[0].parentId references missing span "span_missing"'
    ]);
  });

  it('still loads a valid trace fixture and replays it correctly', async () => {
    const liveFetch = vi.fn(async () => {
      throw new Error('valid fixture replay should satisfy fetch from the trace');
    });
    vi.stubGlobal('fetch', liveFetch);

    const replayed = await ghost.replay(
      fixturePath('valid-http.ghosttrace.json'),
      async () => {
        const response = await fetch('https://api.example.test/valid-fixture');

        return {
          status: response.status,
          body: await response.text()
        };
      },
      { mode: 'partial', replayTypes: [SpanType.Http] }
    );

    expect(replayed.output).toEqual({
      status: 200,
      body: 'fixture-body'
    });
    expect(replayed.spansMatched).toHaveLength(1);
    expect(replayed.spansMatched[0]?.span.type).toBe(SpanType.Http);
    expect(liveFetch).not.toHaveBeenCalled();
  });
});
