import { describe, expect, it } from 'vitest';
import { SpanType, createTrace, diff, ghost, type Span, type Trace } from '../../src/index.js';

function span(
  id: string,
  type: SpanType,
  name: string,
  fields: Partial<Span> = {}
): Span {
  return {
    id,
    parentId: null,
    type,
    name,
    startTime: 0,
    endTime: 1,
    duration: 1,
    input: {},
    output: {},
    children: [],
    error: null,
    metadata: {},
    ...fields
  };
}

function trace(spans: readonly Span[]): Trace {
  return createTrace({
    id: 'trace_contract',
    name: 'contract',
    endTime: Math.max(1, spans.length),
    spans
  });
}

describe('contract diff engine', () => {
  it('exposes the diff engine through named and ghost namespace APIs', () => {
    expect(typeof diff).toBe('function');
    expect(ghost.diff).toBe(diff);
  });

  it('uses LCS alignment to report shared spans, additions, removals, and aligned field changes', () => {
    const baseline = trace([
      span('span_0001', SpanType.Http, 'GET /users'),
      span('span_0002', SpanType.Function, 'calculate', { output: { value: 1 } }),
      span('span_0003', SpanType.Fs, 'write report'),
      span('span_0004', SpanType.Db, 'legacy query')
    ]);
    const current = trace([
      span('span_1001', SpanType.Http, 'GET /users'),
      span('span_1002', SpanType.Function, 'calculate', { output: { value: 2 } }),
      span('span_1003', SpanType.Timer, 'new timeout'),
      span('span_1004', SpanType.Fs, 'write report')
    ]);

    const result = diff(baseline, current, {
      allowNewSpans: true,
      allowRemovedSpans: true
    });

    expect(result.stats).toMatchObject({
      aligned: 3,
      added: 1,
      removed: 1,
      changed: 1,
      drift: 3,
      breaking: 0
    });
    expect(result.summary).toContain('3 changes');
    expect(result.status).toBe('drift');
    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'changed',
          spanPath: '$.spans[1]',
          field: 'output.value',
          baseline: 1,
          current: 2,
          severity: 'drift'
        }),
        expect.objectContaining({
          type: 'added',
          spanPath: '$.spans[2]',
          field: '$',
          current: expect.objectContaining({ type: SpanType.Timer, name: 'new timeout' }),
          severity: 'drift'
        }),
        expect.objectContaining({
          type: 'removed',
          spanPath: '$.spans[3]',
          field: '$',
          baseline: expect.objectContaining({ type: SpanType.Db, name: 'legacy query' }),
          severity: 'drift'
        })
      ])
    );

    const added = result.changes.find((change) => change.type === 'added');
    const removed = result.changes.find((change) => change.type === 'removed');
    expect(added === undefined ? true : 'baseline' in added).toBe(false);
    expect(removed === undefined ? true : 'current' in removed).toBe(false);
  });

  it('sets DiffResult status to identical, drift, or breaking from change severities', () => {
    const baseline = trace([
      span('span_0001', SpanType.Function, 'calculate', { output: { value: 1 } })
    ]);

    expect(diff(baseline, baseline).status).toBe('identical');
    expect(diff(baseline, baseline).changes).toHaveLength(0);
    expect(diff(baseline, baseline).summary.length).toBeGreaterThan(0);

    const driftResult = diff(
      baseline,
      trace([span('span_0001', SpanType.Function, 'calculate', { output: { value: 2 } })])
    );
    expect(driftResult.status).toBe('drift');
    expect(driftResult.changes[0]).toMatchObject({ severity: 'drift' });

    const breakingResult = diff(
      baseline,
      trace([span('span_0001', SpanType.Function, 'calculate', { output: { value: 2 } })]),
      { breakingOn: ['output.value'] }
    );
    expect(breakingResult.status).toBe('breaking');
    expect(breakingResult.changes[0]).toMatchObject({ severity: 'breaking' });
  });

  it('applies ignorePaths, allowNewSpans, allowRemovedSpans, and breakingOn independently and together', () => {
    const baseline = trace([
      span('span_0001', SpanType.Http, 'GET /orders', {
        duration: 10,
        output: { status: 200, elapsedMs: 10 }
      }),
      span('span_0002', SpanType.Db, 'legacy query')
    ]);
    const current = trace([
      span('span_1001', SpanType.Http, 'GET /orders', {
        duration: 20,
        output: { status: 500, elapsedMs: 20 }
      }),
      span('span_1002', SpanType.Timer, 'new timeout')
    ]);

    expect(diff(baseline, current).changes.find((change) => change.type === 'added')).toMatchObject({
      severity: 'breaking'
    });
    expect(diff(baseline, current).changes.find((change) => change.type === 'removed')).toMatchObject({
      severity: 'breaking'
    });

    const ignored = diff(baseline, current, {
      ignorePaths: ['duration', 'output.elapsedMs'],
      allowNewSpans: true,
      allowRemovedSpans: true,
      breakingOn: ['output.status']
    });

    expect(ignored.changes.some((change) => change.field === 'duration')).toBe(false);
    expect(ignored.changes.some((change) => change.field === 'output.elapsedMs')).toBe(false);
    expect(ignored.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'added', severity: 'drift' }),
        expect.objectContaining({ type: 'removed', severity: 'drift' }),
        expect.objectContaining({ field: 'output.status', severity: 'breaking' })
      ])
    );
    expect(ignored.status).toBe('breaking');
  });

  it('uses custom field comparators and reports throwing comparator warnings as changes', () => {
    const baseline = trace([
      span('span_0001', SpanType.Performance, 'measure render', { output: { elapsedMs: 10 } })
    ]);
    const current = trace([
      span('span_0001', SpanType.Performance, 'measure render', { output: { elapsedMs: 10.004 } })
    ]);

    const epsilonResult = diff(baseline, current, {
      comparators: {
        'output.elapsedMs': (baselineValue, currentValue) =>
          typeof baselineValue === 'number' &&
          typeof currentValue === 'number' &&
          Math.abs(baselineValue - currentValue) < 0.01
      }
    });

    expect(epsilonResult.status).toBe('identical');
    expect(epsilonResult.changes).toEqual([]);

    const throwingResult = diff(baseline, current, {
      comparators: {
        'output.elapsedMs': () => {
          throw new Error('comparator failed');
        }
      }
    });

    expect(throwingResult.status).toBe('drift');
    expect(throwingResult.changes).toEqual([
      expect.objectContaining({
        type: 'changed',
        field: 'output.elapsedMs',
        baseline: 10,
        current: 10.004,
        severity: 'drift'
      })
    ]);
    expect(throwingResult.warnings).toEqual([
      expect.objectContaining({
        path: '$.spans[0].output.elapsedMs',
        message: expect.stringContaining('comparator failed')
      })
    ]);
  });
});
