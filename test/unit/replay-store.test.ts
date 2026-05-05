import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReplayMismatchError,
  SpanType,
  TRACE_FORMAT_VERSION,
  serialize,
  type Span,
  type Trace
} from '../../src/index.js';
import { createReplayStore, replayCompositeKey } from '../../src/replay/store.js';

function span(
  id: string,
  type: SpanType,
  name: string,
  input: unknown,
  output: unknown = { id }
): Span {
  return {
    id,
    parentId: null,
    type,
    name,
    startTime: 0,
    endTime: 1,
    duration: 1,
    input: serialize(input),
    output: serialize(output),
    children: [],
    error: null,
    metadata: {}
  };
}

function trace(spans: readonly Span[]): Trace {
  return {
    id: 'trace_replay_store_test',
    name: 'replay-store-test',
    version: TRACE_FORMAT_VERSION,
    startTime: 0,
    endTime: spans.length,
    duration: spans.length,
    spans,
    metadata: {}
  };
}

describe('ReplayStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('indexes spans by composite type:name:sequence key with direct lookup', () => {
    const firstFetch = span('span_http_1', SpanType.Http, 'fetch', { url: '/first' });
    const dbFetch = span('span_db_1', SpanType.Db, 'fetch', { url: '/first' });
    const secondFetch = span('span_http_2', SpanType.Http, 'fetch', { url: '/second' });
    const store = createReplayStore(trace([firstFetch, dbFetch, secondFetch]));

    expect(store.getSpan(SpanType.Http, 'fetch', 0)).toBe(firstFetch);
    expect(store.getSpan(SpanType.Db, 'fetch', 0)).toBe(dbFetch);
    expect(store.getSpan(SpanType.Http, 'fetch', 1)).toBe(secondFetch);
    expect(store.getSpanByCompositeKey(replayCompositeKey(SpanType.Http, 'fetch', 1))).toBe(secondFetch);
    expect(store.getSpan(SpanType.Http, 'fetch', 2)).toBeUndefined();
    expect(store.getSpan(SpanType.Db, 'fetch', 1)).toBeUndefined();
  });

  it('indexes spans by global sequence and handles empty traces gracefully', () => {
    const first = span('span_1', SpanType.Http, 'fetch', { url: '/first' });
    const second = span('span_2', SpanType.Db, 'query', { sql: 'select 1' });
    const store = createReplayStore(trace([first, second]));
    const emptyStore = createReplayStore(trace([]));

    expect(store.getSpanByGlobalSequence(0)).toBe(first);
    expect(store.getSpanByGlobalSequence(1)).toBe(second);
    expect(store.getSpanByGlobalSequence(2)).toBeUndefined();
    expect(emptyStore.getSpan(SpanType.Http, 'fetch', 0)).toBeUndefined();
    expect(emptyStore.getSpanByGlobalSequence(0)).toBeUndefined();
    expect(emptyStore.matchedSpans()).toEqual([]);
  });

  it('matches exact composite key before other matching tiers', () => {
    const first = span('span_1', SpanType.Http, 'fetch', { url: '/same' }, { value: 'first' });
    const second = span('span_2', SpanType.Http, 'fetch', { url: '/same' }, { value: 'second' });
    const store = createReplayStore(trace([first, second]));

    const firstMatch = store.consumeSpan(SpanType.Http, 'fetch', { url: '/same' });
    const secondMatch = store.consumeSpan(SpanType.Http, 'fetch', { url: '/same' });

    expect(firstMatch?.span).toBe(first);
    expect(firstMatch?.sequence).toBe(0);
    expect(secondMatch?.span).toBe(second);
    expect(secondMatch?.sequence).toBe(1);
    expect(store.matchedSpans().map((match) => match.strategy)).toEqual(['exact', 'exact']);
  });

  it('matches by input when calls are replayed out of recorded order', () => {
    const first = span('span_1', SpanType.Http, 'fetch', { url: '/first' });
    const second = span('span_2', SpanType.Http, 'fetch', { url: '/second' });
    const store = createReplayStore(trace([first, second]));

    const secondMatch = store.consumeSpan(SpanType.Http, 'fetch', { url: '/second' });
    const firstMatch = store.consumeSpan(SpanType.Http, 'fetch', { url: '/first' });

    expect(secondMatch?.span).toBe(second);
    expect(firstMatch?.span).toBe(first);
    expect(store.matchedSpans().map((match) => match.strategy)).toEqual(['input', 'input']);
  });

  it('falls back to the next unmatched span of the same type without crossing type boundaries', () => {
    const otherHttp = span('span_http_other', SpanType.Http, 'http.request', { url: '/recorded' });
    const dbFetch = span('span_db_fetch', SpanType.Db, 'fetch', { url: '/recorded' });
    const store = createReplayStore(trace([otherHttp, dbFetch]), { mode: 'lenient' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const match = store.consumeSpan(SpanType.Http, 'fetch', { url: '/runtime-only' });
    const missing = store.consumeSpan(SpanType.Http, 'fetch', { url: '/still-missing' });

    expect(match?.span).toBe(otherHttp);
    expect(store.matchedSpans().map((matched) => matched.strategy)).toEqual(['sequential']);
    expect(missing).toBeUndefined();
    expect(store.getSpan(SpanType.Db, 'fetch', 0)).toBe(dbFetch);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('GhostTrace lenient replay pass-through'),
      expect.objectContaining({
        spanType: SpanType.Http,
        name: 'fetch'
      })
    );
  });

  it('throws ReplayMismatchError with diagnostics for misses and never reuses consumed spans', () => {
    const onlySpan = span('span_1', SpanType.Http, 'fetch', { url: '/once' });
    const store = createReplayStore(trace([onlySpan]));

    expect(store.consumeSpan(SpanType.Http, 'fetch', { url: '/once' })?.span).toBe(onlySpan);
    expect(() => store.consumeSpan(SpanType.Http, 'fetch', { url: '/once' })).toThrow(ReplayMismatchError);
    expect(() => createReplayStore(trace([])).consumeSpan(SpanType.Http, 'fetch', { url: '/missing' })).toThrow(
      ReplayMismatchError
    );
  });

  it('isolates span types so a fetch call never matches a DB span with identical input', () => {
    const dbSpan = span('span_db', SpanType.Db, 'fetch', { url: '/same' });
    const store = createReplayStore(trace([dbSpan]), { mode: 'lenient' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(store.consumeSpan(SpanType.Http, 'fetch', { url: '/same' })).toBeUndefined();
    expect(store.matchedSpans()).toEqual([]);
    expect(store.consumeSpan(SpanType.Db, 'fetch', { url: '/same' })?.span).toBe(dbSpan);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('GhostTrace lenient replay pass-through'),
      expect.objectContaining({
        spanType: SpanType.Http,
        name: 'fetch'
      })
    );
  });

  it('atomically consumes distinct spans across 100 concurrent async operations', async () => {
    const spans = Array.from({ length: 100 }, (_, index) =>
      span(`span_${String(index).padStart(3, '0')}`, SpanType.Http, 'fetch', { url: `/item/${index}` })
    );
    const store = createReplayStore(trace(spans));

    const matchedIds = await Promise.all(
      spans.map(async (_, index) => {
        await Promise.resolve();
        return store.consumeSpan(SpanType.Http, 'fetch', { url: `/item/${index}` })?.span.id;
      })
    );

    expect(matchedIds).toHaveLength(100);
    expect(new Set(matchedIds).size).toBe(100);
    expect(matchedIds.every((id) => typeof id === 'string')).toBe(true);
    expect(store.matchedSpans()).toHaveLength(100);
  });
});
