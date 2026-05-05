import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReplayMismatchError,
  SpanType,
  TraceValidationError,
  deserialize,
  ghost,
  type SerializedJsonValue,
  type Span
} from '../../src/index.js';

const PARTIAL_ENV_KEY = 'GHOSTTRACE_REPLAY_PARTIAL_ENV';

function deserializeAs<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

function httpSpans(spans: readonly Span[]): readonly Span[] {
  return spans.filter((span) => span.type === SpanType.Http);
}

async function createTempDir(): Promise<string> {
  return fsPromises.mkdtemp(join(tmpdir(), 'ghosttrace-replay-api-'));
}

describe('ghost.replay API and modes', () => {
  afterEach(() => {
    delete process.env[PARTIAL_ENV_KEY];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('strict mode throws for extra runtime calls and reports missing recorded calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => new Response(`recorded:${String(input)}`))
    );
    const trace = await ghost.record(
      'strict-full-match',
      async () => {
        await fetch('https://api.example.test/first');
        await fetch('https://api.example.test/second');

        return 'recorded';
      },
      { interceptors: ['http'] }
    );
    const fetchTraceSpans = httpSpans(trace.spans);
    expect(fetchTraceSpans).toHaveLength(2);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('strict replay must not pass through unmatched fetches');
      })
    );

    await expect(
      ghost.replay(trace, async () => {
        await fetch('https://api.example.test/first');
        await fetch('https://api.example.test/second');
        await fetch('https://api.example.test/extra');

        return 'extra';
      })
    ).rejects.toBeInstanceOf(ReplayMismatchError);

    await expect(
      ghost.replay(trace, async () => {
        await fetch('https://api.example.test/first');

        return 'missing';
      })
    ).rejects.toMatchObject({
      name: ReplayMismatchError.name,
      code: 'GHOSTTRACE_REPLAY_MISMATCH',
      context: {
        unmatchedSpans: [
          {
            id: fetchTraceSpans[1]?.id,
            type: SpanType.Http,
            name: 'fetch'
          }
        ]
      }
    });
  });

  it('lenient mode passes unmatched calls through and emits a warning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => new Response(`recorded:${String(input)}`))
    );
    const trace = await ghost.record(
      'lenient-passthrough',
      async () => {
        const response = await fetch('https://api.example.test/recorded');
        return response.text();
      },
      { interceptors: ['http'] }
    );
    const expectedRecordedBody = deserializeAs<string>(trace.spans[0]?.output);
    const liveFetch = vi.fn(async (input: RequestInfo | URL) => new Response(`live:${String(input)}`));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', liveFetch);

    const replayed = await ghost.replay(
      trace,
      async () => {
        const recorded = await fetch('https://api.example.test/recorded');
        const live = await fetch('https://api.example.test/live-only');

        return {
          recorded: await recorded.text(),
          live: await live.text()
        };
      },
      { mode: 'lenient' }
    );

    expect(replayed.output).toEqual({
      recorded: expectedRecordedBody,
      live: 'live:https://api.example.test/live-only'
    });
    expect(replayed.spansMatched.map((match) => match.span.id)).toEqual([httpSpans(trace.spans)[0]?.id]);
    expect(liveFetch).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('GhostTrace lenient replay pass-through'),
      expect.objectContaining({
        spanType: SpanType.Http,
        name: 'fetch'
      })
    );
  });

  it('partial mode replays only requested span types and lets other operations execute live', async () => {
    process.env[PARTIAL_ENV_KEY] = 'recorded-env';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('recorded-http')));
    const trace = await ghost.record(
      'partial-http-only',
      async () => {
        const response = await fetch('https://api.example.test/partial');

        return {
          http: await response.text(),
          env: process.env[PARTIAL_ENV_KEY]
        };
      },
      { interceptors: ['http', 'env'] }
    );
    process.env[PARTIAL_ENV_KEY] = 'live-env';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('partial replay should satisfy HTTP from the trace');
      })
    );

    const replayed = await ghost.replay(
      trace,
      async () => {
        const response = await fetch('https://api.example.test/partial');

        return {
          http: await response.text(),
          env: process.env[PARTIAL_ENV_KEY]
        };
      },
      { mode: 'partial', replayTypes: [SpanType.Http] }
    );

    expect(replayed.output).toEqual({
      http: 'recorded-http',
      env: 'live-env'
    });
    expect(replayed.spansMatched.map((match) => match.span.type)).toEqual([SpanType.Http]);
  });

  it('accepts trace objects without file I/O and trace file paths loaded from disk', async () => {
    const directory = await createTempDir();
    const trace = await ghost.record('object-and-path-replay', () => 'recorded-output', {
      interceptors: []
    });
    const fromObject = await ghost.replay(trace, () => 'object-output');
    expect(fromObject.output).toBe('object-output');
    expect(fromObject.originalDuration).toBe(trace.duration);
    expect(typeof fromObject.replayDuration).toBe('number');
    expect(fromObject.replayDuration).toBeGreaterThanOrEqual(0);
    expect(fromObject.spansMatched).toEqual([]);

    const tracePath = await trace.save(join(directory, 'replay-object-path.ghosttrace.json'));
    const fromPath = await ghost.replay(tracePath, () => 'path-output');
    expect(fromPath.output).toBe('path-output');
    expect(fromPath.originalDuration).toBe(trace.duration);
    expect(fromPath.spansMatched).toEqual([]);

    await fsPromises.rm(directory, { recursive: true, force: true });
  });

  it('throws descriptive errors for missing and corrupted trace files', async () => {
    const directory = await createTempDir();
    const missingPath = join(directory, 'missing.ghosttrace.json');
    const invalidJsonPath = join(directory, 'invalid.ghosttrace.json');
    await fsPromises.writeFile(invalidJsonPath, '{ not valid json', 'utf8');

    await expect(ghost.replay(missingPath, () => 'missing')).rejects.toMatchObject({
      name: TraceValidationError.name,
      code: 'GHOSTTRACE_REPLAY_TRACE_NOT_FOUND',
      message: expect.stringContaining(missingPath)
    });
    await expect(ghost.replay(invalidJsonPath, () => 'invalid')).rejects.toMatchObject({
      name: TraceValidationError.name,
      code: 'GHOSTTRACE_REPLAY_TRACE_PARSE_ERROR',
      message: expect.stringContaining(invalidJsonPath)
    });

    await fsPromises.rm(directory, { recursive: true, force: true });
  });
});
