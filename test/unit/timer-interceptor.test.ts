import { afterEach, describe, expect, it } from 'vitest';
import { SpanType, ghost, type Span } from '../../src/index.js';

function spansOfType(spans: readonly Span[], type: SpanType): readonly Span[] {
  return spans.filter((span) => span.type === type);
}

function recordValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  return (value as Readonly<Record<string, unknown>>)[key];
}

describe('timer interceptor', () => {
  afterEach(() => {
    // Timer tests intentionally use long delays and clear immediately; this is a final safety net.
    for (const handle of pendingTimerHandles.splice(0)) {
      clearTimeout(handle);
      clearInterval(handle);
    }
  });

  const pendingTimerHandles: Array<ReturnType<typeof setTimeout>> = [];

  it('records setTimeout, setInterval, clearTimeout, and clearInterval with delay and timer IDs', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalSetInterval = globalThis.setInterval;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalClearInterval = globalThis.clearInterval;

    const trace = await ghost.record(
      'timer-operations',
      () => {
        expect(globalThis.setTimeout).not.toBe(originalSetTimeout);
        expect(globalThis.setInterval).not.toBe(originalSetInterval);
        expect(globalThis.clearTimeout).not.toBe(originalClearTimeout);
        expect(globalThis.clearInterval).not.toBe(originalClearInterval);

        const timeout = setTimeout(() => undefined, 60_000);
        pendingTimerHandles.push(timeout);
        clearTimeout(timeout);

        const interval = setInterval(() => undefined, 60_000);
        pendingTimerHandles.push(interval);
        clearInterval(interval);

        clearTimeout(123 as unknown as ReturnType<typeof setTimeout>);
        return 'timers-recorded';
      },
      { interceptors: ['timer'] }
    );

    expect(globalThis.setTimeout).toBe(originalSetTimeout);
    expect(globalThis.setInterval).toBe(originalSetInterval);
    expect(globalThis.clearTimeout).toBe(originalClearTimeout);
    expect(globalThis.clearInterval).toBe(originalClearInterval);

    const timerSpans = spansOfType(trace.spans, SpanType.Timer);
    expect(timerSpans.map((span) => span.name)).toEqual([
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'clearTimeout'
    ]);
    expect(timerSpans[0]).toMatchObject({
      input: {
        operation: 'setTimeout',
        delay: 60_000
      },
      output: {
        timerId: 'timer_0001'
      },
      metadata: {
        operation: 'setTimeout',
        delay: 60_000,
        timerId: 'timer_0001'
      }
    });
    expect(timerSpans[1]).toMatchObject({
      input: {
        operation: 'clearTimeout',
        timerId: 'timer_0001'
      },
      metadata: {
        timerId: 'timer_0001'
      }
    });
    expect(timerSpans[2]).toMatchObject({
      input: {
        operation: 'setInterval',
        delay: 60_000
      },
      output: {
        timerId: 'timer_0002'
      },
      metadata: {
        timerId: 'timer_0002'
      }
    });
    expect(timerSpans[4]).toMatchObject({
      input: {
        operation: 'clearTimeout',
        timerId: 'untracked'
      },
      metadata: {
        timerId: 'untracked'
      }
    });
  });

  it('replays Date.now and new Date from the exact recorded sequence', async () => {
    const originalDate = Date;
    const trace = await ghost.record(
      'date-determinism',
      () => {
        const first = Date.now();
        const second = Date.now();
        const constructed = new Date();

        return {
          first,
          second,
          constructedIso: constructed.toISOString()
        };
      },
      { interceptors: ['timer'] }
    );
    const dateSpans = spansOfType(trace.spans, SpanType.Timer).filter((span) =>
      ['Date.now', 'new Date'].includes(span.name)
    );
    const expected = {
      first: recordValue(dateSpans[0]?.output, 'value'),
      second: recordValue(dateSpans[1]?.output, 'value'),
      constructedIso: recordValue(dateSpans[2]?.output, 'iso')
    };

    expect(dateSpans.map((span) => span.name)).toEqual(['Date.now', 'Date.now', 'new Date']);
    expect(Date).toBe(originalDate);

    const replayed = await ghost.replay(trace, () => ({
      first: Date.now(),
      second: Date.now(),
      constructedIso: new Date().toISOString()
    }));

    expect(replayed.output).toEqual(expected);
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual(['Date.now', 'Date.now', 'new Date']);
    expect(Date).toBe(originalDate);
  });

  it('matches replayed timers by delay and callback identity when scheduling order changes', async () => {
    let firedCallbacks: string[] = [];
    function firstTimerCallback(): void {
      firedCallbacks.push('first');
    }
    function secondTimerCallback(): void {
      firedCallbacks.push('second');
    }

    const trace = await ghost.record(
      'timer-reordered-replay',
      () => {
        const first = setTimeout(firstTimerCallback, 60_001);
        const second = setTimeout(secondTimerCallback, 60_002);
        pendingTimerHandles.push(first, second);

        return 'recorded';
      },
      { interceptors: ['timer'] }
    );

    firedCallbacks = [];
    const replayed = await ghost.replay(trace, () => {
      setTimeout(secondTimerCallback, 60_002);
      setTimeout(firstTimerCallback, 60_001);

      return [...firedCallbacks];
    });

    expect(replayed.output).toEqual(['second', 'first']);
    expect(replayed.spansMatched.map((match) => recordValue(match.span.input, 'delay'))).toEqual([60_002, 60_001]);
    expect(replayed.spansMatched.map((match) => recordValue(match.span.input, 'callbackName'))).toEqual([
      'secondTimerCallback',
      'firstTimerCallback'
    ]);
    expect(replayed.spansMatched.map((match) => match.strategy)).toEqual(['input', 'input']);
  });
});
