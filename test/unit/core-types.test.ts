import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  SpanType,
  TRACE_FORMAT_VERSION,
  createTracer,
  ghost,
  type ReplayResult,
  type ReplaySpanMatch,
  type Span,
  type SpanMetadata,
  type Trace,
  type TraceMetadata
} from '../../src/index.js';

function omitKey<TObject extends object, TKey extends keyof TObject>(
  object: TObject,
  key: TKey
): Omit<TObject, TKey> {
  const { [key]: _omitted, ...rest } = object;
  void _omitted;
  return rest;
}

function acceptTrace(_trace: Trace): void {
  return undefined;
}

function acceptSpan(_span: Span): void {
  return undefined;
}

const spanMetadata = {
  module: 'calculator',
  stable: true
} satisfies SpanMetadata;

const baseSpan = {
  id: 'span_0001',
  parentId: null,
  type: SpanType.Function,
  name: 'add',
  startTime: 0,
  endTime: 3,
  duration: 3,
  input: [1, 2] as const,
  output: { sum: 3 } as const,
  children: [],
  error: null,
  metadata: spanMetadata
} satisfies Span<readonly [1, 2], { readonly sum: 3 }>;

const traceMetadata = {
  recordedAt: '2026-05-05T00:00:00.000Z',
  runtime: 'node'
} satisfies TraceMetadata;

const baseTrace = {
  id: 'trace_0001',
  name: 'core-types',
  version: TRACE_FORMAT_VERSION,
  startTime: 0,
  endTime: 3,
  duration: 3,
  spans: [baseSpan],
  metadata: traceMetadata
} satisfies Trace<typeof baseSpan>;

describe('core data model types', () => {
  it('requires every Trace field at compile time and exposes them at runtime', () => {
    acceptTrace(baseTrace);

    // @ts-expect-error Trace.id is required.
    acceptTrace(omitKey(baseTrace, 'id'));
    // @ts-expect-error Trace.name is required.
    acceptTrace(omitKey(baseTrace, 'name'));
    // @ts-expect-error Trace.version is required.
    acceptTrace(omitKey(baseTrace, 'version'));
    // @ts-expect-error Trace.startTime is required.
    acceptTrace(omitKey(baseTrace, 'startTime'));
    // @ts-expect-error Trace.endTime is required.
    acceptTrace(omitKey(baseTrace, 'endTime'));
    // @ts-expect-error Trace.duration is required.
    acceptTrace(omitKey(baseTrace, 'duration'));
    // @ts-expect-error Trace.spans is required.
    acceptTrace(omitKey(baseTrace, 'spans'));
    // @ts-expect-error Trace.metadata is required.
    acceptTrace(omitKey(baseTrace, 'metadata'));

    expect(baseTrace).toMatchObject({
      id: 'trace_0001',
      name: 'core-types',
      version: TRACE_FORMAT_VERSION,
      startTime: 0,
      endTime: 3,
      duration: 3,
      metadata: traceMetadata
    });
    expect(baseTrace.spans).toEqual([baseSpan]);
  });

  it('requires every Span field at compile time and exposes them at runtime', () => {
    acceptSpan(baseSpan);

    // @ts-expect-error Span.id is required.
    acceptSpan(omitKey(baseSpan, 'id'));
    // @ts-expect-error Span.parentId is required.
    acceptSpan(omitKey(baseSpan, 'parentId'));
    // @ts-expect-error Span.type is required.
    acceptSpan(omitKey(baseSpan, 'type'));
    // @ts-expect-error Span.name is required.
    acceptSpan(omitKey(baseSpan, 'name'));
    // @ts-expect-error Span.startTime is required.
    acceptSpan(omitKey(baseSpan, 'startTime'));
    // @ts-expect-error Span.endTime is required.
    acceptSpan(omitKey(baseSpan, 'endTime'));
    // @ts-expect-error Span.duration is required.
    acceptSpan(omitKey(baseSpan, 'duration'));
    // @ts-expect-error Span.input is required.
    acceptSpan(omitKey(baseSpan, 'input'));
    // @ts-expect-error Span.output is required.
    acceptSpan(omitKey(baseSpan, 'output'));
    // @ts-expect-error Span.children is required.
    acceptSpan(omitKey(baseSpan, 'children'));
    // @ts-expect-error Span.error is required.
    acceptSpan(omitKey(baseSpan, 'error'));
    // @ts-expect-error Span.metadata is required.
    acceptSpan(omitKey(baseSpan, 'metadata'));

    expect(baseSpan).toMatchObject({
      id: 'span_0001',
      parentId: null,
      type: SpanType.Function,
      name: 'add',
      startTime: 0,
      endTime: 3,
      duration: 3,
      input: [1, 2],
      output: { sum: 3 },
      children: [],
      error: null,
      metadata: spanMetadata
    });
  });

  it('exports exactly ten string-valued SpanType enum members', () => {
    const expectedValues = [
      'function',
      'http',
      'timer',
      'random',
      'env',
      'fs',
      'db',
      'queue',
      'error',
      'performance'
    ] as const;
    const values = Object.values(SpanType);

    expect(values).toEqual(expectedValues);
    expect(values).toHaveLength(10);
    expect(values.every((value) => typeof value === 'string')).toBe(true);
  });

  it('preserves generic inference for parameterized consumer-facing types', () => {
    expectTypeOf(baseSpan.input).toEqualTypeOf<readonly [1, 2]>();
    expectTypeOf(baseSpan.output).toEqualTypeOf<{ readonly sum: 3 }>();
    expectTypeOf(baseTrace.spans[0]).toEqualTypeOf<typeof baseSpan | undefined>();

    const matchedSpan = {
      span: baseSpan,
      strategy: 'exact',
      sequence: 0
    } satisfies ReplaySpanMatch<typeof baseSpan>;

    const replayResult = {
      output: { ok: true, value: 3 } as const,
      spansMatched: [matchedSpan],
      originalDuration: 3,
      replayDuration: 1
    } satisfies ReplayResult<{ readonly ok: true; readonly value: 3 }, typeof baseSpan>;

    expectTypeOf(replayResult.output).toEqualTypeOf<{ readonly ok: true; readonly value: 3 }>();
    expectTypeOf(replayResult.spansMatched[0]).toMatchTypeOf<
      ReplaySpanMatch<typeof baseSpan> | undefined
    >();

    function _replayForConsumer() {
      return ghost.replay(baseTrace, async () => ({ ok: true, value: 3 }) as const);
    }

    expectTypeOf<Awaited<ReturnType<typeof _replayForConsumer>>['output']>().toEqualTypeOf<{
      readonly ok: true;
      readonly value: 3;
    }>();
  });

  it('threads custom span generics through replay API results', () => {
    interface CustomReplaySpan
      extends Span<
        { readonly operation: 'fetch-user'; readonly userId: string },
        { readonly status: 200; readonly body: { readonly name: string } }
      > {
      readonly customKind: 'http-fixture';
      readonly metadata: SpanMetadata & {
        readonly requestId: string;
      };
    }

    const customSpan = {
      id: 'span_0002',
      parentId: null,
      type: SpanType.Http,
      name: 'GET /users/123',
      startTime: 0,
      endTime: 5,
      duration: 5,
      input: { operation: 'fetch-user', userId: '123' },
      output: { status: 200, body: { name: 'Ada' } },
      children: [],
      error: null,
      metadata: { requestId: 'req_123' },
      customKind: 'http-fixture'
    } satisfies CustomReplaySpan;

    const customTrace: Trace<CustomReplaySpan> = {
      id: 'trace_0002',
      name: 'custom replay trace',
      version: TRACE_FORMAT_VERSION,
      startTime: 0,
      endTime: 5,
      duration: 5,
      spans: [customSpan],
      metadata: {}
    };

    function _ghostReplayForCustomTrace() {
      return ghost.replay(customTrace, async () => ({ ok: true, userName: 'Ada' }) as const);
    }

    function _tracerReplayForCustomTrace() {
      return createTracer().replay(customTrace, async () => ({ ok: true, userName: 'Ada' }) as const);
    }

    type GhostReplayResult = Awaited<ReturnType<typeof _ghostReplayForCustomTrace>>;
    type TracerReplayResult = Awaited<ReturnType<typeof _tracerReplayForCustomTrace>>;

    expectTypeOf<GhostReplayResult['output']>().toEqualTypeOf<{
      readonly ok: true;
      readonly userName: 'Ada';
    }>();
    expectTypeOf<TracerReplayResult['output']>().toEqualTypeOf<{
      readonly ok: true;
      readonly userName: 'Ada';
    }>();
    expectTypeOf<GhostReplayResult['spansMatched'][number]>().toEqualTypeOf<
      ReplaySpanMatch<CustomReplaySpan>
    >();
    expectTypeOf<TracerReplayResult['spansMatched'][number]>().toEqualTypeOf<
      ReplaySpanMatch<CustomReplaySpan>
    >();
    expectTypeOf<GhostReplayResult['spansMatched'][number]['span']['customKind']>().toEqualTypeOf<
      'http-fixture'
    >();
    expectTypeOf<
      TracerReplayResult['spansMatched'][number]['span']['metadata']['requestId']
    >().toEqualTypeOf<string>();
  });
});
