import { describe, expect, it } from 'vitest';
import { createTraceContext, getTraceContext, runWithTraceContext } from '../../src/index.js';

function waitForTimer(): Promise<string | undefined> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(getTraceContext()?.traceId);
    }, 0);
  });
}

async function runIsolatedRecording(traceId: string): Promise<{
  readonly traceId: string | undefined;
  readonly spanIds: readonly string[];
  readonly timestamps: readonly number[];
}> {
  const context = createTraceContext({ traceId });

  return runWithTraceContext(context, async () => {
    const activeContext = getTraceContext();
    if (activeContext === undefined) {
      throw new Error('expected trace context before await');
    }
    const firstSpanId = activeContext.idGenerator.next();
    const firstTimestamp = activeContext.clock.now();

    await Promise.resolve();

    const resumedContext = getTraceContext();
    if (resumedContext === undefined) {
      throw new Error('expected trace context after await');
    }
    const secondSpanId = resumedContext.idGenerator.next();
    const secondTimestamp = resumedContext.clock.now();

    return {
      traceId: resumedContext.traceId,
      spanIds: [firstSpanId, secondSpanId],
      timestamps: [firstTimestamp, secondTimestamp]
    };
  });
}

describe('AsyncLocalStorage trace context', () => {
  it('propagates across await, Promise.all, and setTimeout callbacks', async () => {
    const context = createTraceContext({ traceId: 'trace_async_boundaries' });

    await runWithTraceContext(context, async () => {
      expect(getTraceContext()).toBe(context);

      await Promise.resolve();
      expect(getTraceContext()?.traceId).toBe('trace_async_boundaries');

      const traceIds = await Promise.all([
        Promise.resolve().then(() => getTraceContext()?.traceId),
        waitForTimer()
      ]);

      expect(traceIds).toEqual(['trace_async_boundaries', 'trace_async_boundaries']);
    });

    expect(getTraceContext()).toBeUndefined();
  });

  it('isolates concurrent recordings and their deterministic utilities', async () => {
    const [first, second] = await Promise.all([
      runIsolatedRecording('trace_concurrent_a'),
      runIsolatedRecording('trace_concurrent_b')
    ]);

    expect(first).toEqual({
      traceId: 'trace_concurrent_a',
      spanIds: ['span_0001', 'span_0002'],
      timestamps: [0, 1]
    });
    expect(second).toEqual({
      traceId: 'trace_concurrent_b',
      spanIds: ['span_0001', 'span_0002'],
      timestamps: [0, 1]
    });
  });
});
