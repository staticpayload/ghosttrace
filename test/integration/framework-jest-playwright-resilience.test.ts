import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplayMismatchError, SpanType, deserialize, serialize, type SerializedJsonValue, type Trace } from '../../src/index.js';
import { withGhostTrace } from '../../src/integrations/jest.js';
import { createGhostPlaywright, type GhostPlaywrightController } from '../../src/integrations/playwright.js';

const tempRoots: string[] = [];

interface FulfilledResponse {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
}

interface FakePlaywrightRequest {
  readonly url: () => string;
  readonly method: () => string;
  readonly headers: () => Record<string, string>;
  readonly postData: () => string | null;
}

interface FakePlaywrightResponse {
  readonly status: () => number;
  readonly statusText: () => string;
  readonly headers: () => Record<string, string>;
  readonly body: () => Promise<Buffer>;
}

interface FakePlaywrightRoute {
  readonly request: () => FakePlaywrightRequest;
  readonly fetch: () => Promise<FakePlaywrightResponse>;
  readonly fulfill: (response: FulfilledResponse) => Promise<void>;
}

type FakeRouteHandler = (route: FakePlaywrightRoute) => void | Promise<void>;

interface FakePlaywrightPage {
  readonly route: (url: string, handler: FakeRouteHandler) => Promise<void>;
}

interface FakeServerState {
  readonly body: string;
  readonly offline?: boolean;
  fetchCount: number;
}

interface FakePageHarness {
  readonly page: FakePlaywrightPage;
  readonly request: (url: string) => Promise<FulfilledResponse>;
  readonly fetchCount: () => number;
}

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function readTrace(filePath: string): Trace {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Trace;
}

function deserializeAs<TValue>(value: unknown): TValue {
  return deserialize(value as SerializedJsonValue) as TValue;
}

function rootOutput(trace: Trace): unknown {
  return trace.spans.find((span) => span.parentId === null && span.type === SpanType.Function)?.output;
}

function traceWithRootOutput(trace: Trace, output: unknown): Trace {
  return {
    ...trace,
    spans: trace.spans.map((span) =>
      span.parentId === null && span.type === SpanType.Function
        ? {
            ...span,
            output: serialize(output)
          }
        : span
    )
  };
}

function createFakeResponse(state: FakeServerState): FakePlaywrightResponse {
  return {
    status: () => 200,
    statusText: () => 'OK',
    headers: () => ({
      'content-type': 'application/json',
      'x-source': 'live-server'
    }),
    body: async () => Buffer.from(state.body, 'utf8')
  };
}

function createFakePage(state: FakeServerState): FakePageHarness {
  let routeHandler: FakeRouteHandler | undefined;

  return {
    page: {
      route: async (_url: string, handler: FakeRouteHandler): Promise<void> => {
        routeHandler = handler;
      }
    },
    request: async (url: string): Promise<FulfilledResponse> => {
      if (routeHandler === undefined) {
        throw new Error('No route handler was installed');
      }

      let fulfilled: FulfilledResponse | undefined;
      const route: FakePlaywrightRoute = {
        request: () => ({
          url: () => url,
          method: () => 'GET',
          headers: () => ({ accept: 'application/json' }),
          postData: () => null
        }),
        fetch: async () => {
          if (state.offline === true) {
            throw new Error('server is offline');
          }

          state.fetchCount += 1;
          return createFakeResponse(state);
        },
        fulfill: async (response: FulfilledResponse): Promise<void> => {
          fulfilled = response;
        }
      };

      await routeHandler(route);
      if (fulfilled === undefined) {
        throw new Error('Route was not fulfilled');
      }

      return fulfilled;
    },
    fetchCount: () => state.fetchCount
  };
}

function traceFiles(traceDir: string): string[] {
  return readdirSync(traceDir)
    .filter((fileName) => fileName.endsWith('.ghosttrace.json'))
    .map((fileName) => join(traceDir, fileName));
}

describe('Jest and Playwright framework integrations', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('withGhostTrace records first run, replays later runs, awaits async tests, and names the trace after the test', async () => {
    const traceDir = join(createTempRoot('ghosttrace-jest-integration-'), 'traces');
    const envKey = 'GHOSTTRACE_JEST_ASYNC_VALUE';
    const wrapped = withGhostTrace(
      'Jest suite awaits async test name',
      async () => {
        await Promise.resolve();
        return `jest:${process.env[envKey]}`;
      },
      { traceDir, interceptors: ['env'] }
    );

    process.env[envKey] = 'recorded';
    await expect(wrapped()).resolves.toBe('jest:recorded');

    const files = traceFiles(traceDir);
    expect(files).toHaveLength(1);
    expect(basename(files[0] ?? '')).toContain('jest-suite-awaits-async-test-name');

    const savedTrace = readTrace(files[0] ?? '');
    expect(deserializeAs<string>(rootOutput(savedTrace))).toBe('jest:recorded');
    expect(savedTrace.spans.map((span) => span.type)).toContain(SpanType.Env);

    process.env[envKey] = 'changed-live-value';
    await expect(wrapped()).resolves.toBe('jest:recorded');

    delete process.env[envKey];
  });

  it('withGhostTrace re-records corrupted and deleted traces with warnings', async () => {
    const traceDir = join(createTempRoot('ghosttrace-jest-resilience-'), 'traces');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let currentValue = 'initial';
    const wrapped = withGhostTrace('Jest corrupted and deleted trace', async () => currentValue, { traceDir });

    await expect(wrapped()).resolves.toBe('initial');
    const traceFile = traceFiles(traceDir)[0] ?? '';

    writeFileSync(traceFile, '{ broken JSON', 'utf8');
    currentValue = 'after-corruption';
    await expect(wrapped()).resolves.toBe('after-corruption');

    rmSync(traceFile, { force: true });
    currentValue = 'after-delete';
    await expect(wrapped()).resolves.toBe('after-delete');

    const warnings = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warnings).toMatch(/re-recording/i);
    expect(warnings).toMatch(/invalid|parse|missing/i);
  });

  it('withGhostTrace compares replay output against the beforeReplay-transformed baseline', async () => {
    const traceDir = join(createTempRoot('ghosttrace-jest-before-replay-transform-'), 'traces');
    let currentValue = 'recorded-baseline';
    const wrapped = withGhostTrace('Jest beforeReplay transformed trace', async () => currentValue, {
      traceDir,
      plugins: [
        {
          name: 'framework-before-replay-transform',
          version: '1.0.0',
          hooks: {
            beforeReplay: (trace) => traceWithRootOutput(trace, 'transformed-baseline'),
            afterReplay: (trace) => traceWithRootOutput(trace, 'after-replay-view')
          }
        }
      ]
    });

    await expect(wrapped()).resolves.toBe('recorded-baseline');

    currentValue = 'transformed-baseline';
    await expect(wrapped()).resolves.toBe('transformed-baseline');
  });

  it('interceptPage records real page network once and replays offline without contacting the server', async () => {
    const traceDir = join(createTempRoot('ghosttrace-playwright-integration-'), 'traces');
    const controller = createGhostPlaywright({ traceDir, traceName: 'Playwright network test' });
    const recordingHarness = createFakePage({ body: '{"phase":"record"}', fetchCount: 0 });

    await controller.interceptPage(recordingHarness.page);
    const recordedResponse = await recordingHarness.request('https://example.test/api/data');

    expect(recordingHarness.fetchCount()).toBe(1);
    expect(recordedResponse.status).toBe(200);
    expect(String(recordedResponse.body)).toBe('{"phase":"record"}');
    expect(existsSync(controller.traceFile)).toBe(true);

    const savedTrace = readTrace(controller.traceFile);
    expect(savedTrace.spans.map((span) => span.type)).toContain(SpanType.Http);

    const replayHarness = createFakePage({ body: '{"phase":"offline"}', offline: true, fetchCount: 0 });
    await controller.interceptPage(replayHarness.page);
    const replayedResponse = await replayHarness.request('https://example.test/api/data');

    expect(replayHarness.fetchCount()).toBe(0);
    expect(replayedResponse.status).toBe(200);
    expect(String(replayedResponse.body)).toBe('{"phase":"record"}');
  });

  it('interceptPage raises a replay mismatch for unmatched requests instead of falling back to an unused span', async () => {
    const traceDir = join(createTempRoot('ghosttrace-playwright-mismatch-'), 'traces');
    const controller = createGhostPlaywright({ traceDir, traceName: 'Playwright mismatch test' });
    const recordingHarness = createFakePage({ body: '{"phase":"record"}', fetchCount: 0 });

    await controller.interceptPage(recordingHarness.page);
    await recordingHarness.request('https://example.test/api/recorded');

    const replayHarness = createFakePage({ body: '{"phase":"offline"}', offline: true, fetchCount: 0 });
    await controller.interceptPage(replayHarness.page);

    await expect(replayHarness.request('https://example.test/api/different')).rejects.toBeInstanceOf(
      ReplayMismatchError
    );
    expect(replayHarness.fetchCount()).toBe(0);
  });

  it('interceptPage re-records corrupted traces with a warning instead of crashing', async () => {
    const traceDir = join(createTempRoot('ghosttrace-playwright-resilience-'), 'traces');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller: GhostPlaywrightController = createGhostPlaywright({
      traceDir,
      traceName: 'Playwright corrupted trace'
    });
    const firstHarness = createFakePage({ body: '{"phase":"first"}', fetchCount: 0 });

    await controller.interceptPage(firstHarness.page);
    await firstHarness.request('https://example.test/api/data');
    writeFileSync(controller.traceFile, 'not-json', 'utf8');

    const secondHarness = createFakePage({ body: '{"phase":"second"}', fetchCount: 0 });
    await controller.interceptPage(secondHarness.page);
    const response = await secondHarness.request('https://example.test/api/data');

    expect(secondHarness.fetchCount()).toBe(1);
    expect(String(response.body)).toBe('{"phase":"second"}');
    expect(warnSpy.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/re-recording/i);
  });
});
