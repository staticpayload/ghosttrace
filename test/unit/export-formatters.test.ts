import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deserialize,
  ExportError,
  SpanType,
  TRACE_FORMAT_VERSION,
  exportHtml,
  exportJson,
  exportMarkdown,
  exportMermaid,
  exportTrace,
  type DiffResult,
  type Span,
  type Trace
} from '../../src/index.js';
import { diff } from '../../src/contract/diff.js';

interface TestSpanOptions {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: SpanType;
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function span(options: TestSpanOptions): Span {
  return {
    id: options.id,
    parentId: options.parentId,
    type: options.type,
    name: options.name,
    startTime: options.startTime,
    endTime: options.startTime + options.duration,
    duration: options.duration,
    input: options.input ?? [],
    output: options.output,
    children: [],
    error: null,
    metadata: options.metadata ?? {}
  };
}

function trace(spans: readonly Span[]): Trace {
  return {
    id: 'trace_export_test',
    name: 'checkout <flow> "A&B"',
    version: TRACE_FORMAT_VERSION,
    startTime: 0,
    endTime: 12,
    duration: 12,
    spans,
    metadata: {
      recordedAt: '2026-05-05T00:00:00.000Z'
    }
  };
}

const rootSpan = span({
  id: 'span_0001',
  parentId: null,
  type: SpanType.Function,
  name: 'checkout <flow> "A&B"',
  startTime: 0,
  duration: 12
});

const httpSpan = span({
  id: 'span_0002',
  parentId: 'span_0001',
  type: SpanType.Http,
  name: 'GET /api/<orders>?q="A&B"',
  startTime: 2,
  duration: 4,
  input: {
    method: 'GET',
    url: 'https://example.test/api/<orders>?q="A&B"'
  },
  output: {
    status: 200
  },
  metadata: {
    statusCode: 200
  }
});

const timerSpan = span({
  id: 'span_0003',
  parentId: 'span_0001',
  type: SpanType.Timer,
  name: 'setTimeout(callback)',
  startTime: 7,
  duration: 1
});

const sampleTrace = trace([
  {
    ...rootSpan,
    children: [httpSpan, timerSpan]
  },
  httpSpan,
  timerSpan
]);

function embeddedViewerData(html: string): unknown {
  const match = html.match(/<script id="ghosttrace-data" type="application\/json">(?<json>[\s\S]*?)<\/script>/u);
  if (match?.groups?.json === undefined) {
    throw new Error('Embedded viewer JSON script not found');
  }

  return JSON.parse(match.groups.json);
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a plain object record');
  }

  return value as Record<string, unknown>;
}

describe('export formatters', () => {
  it('exports pretty and compact JSON that round-trip to the same trace data', () => {
    const pretty = exportJson(sampleTrace, { mode: 'pretty' });
    const compact = exportJson(sampleTrace, { mode: 'compact' });

    expect(pretty).toContain('\n');
    expect(pretty).toContain('\n  "id": "trace_export_test"');
    expect(compact).not.toContain('\n');
    expect(deserialize<Trace>(JSON.parse(pretty))).toEqual(sampleTrace);
    expect(deserialize<Trace>(JSON.parse(compact))).toEqual(sampleTrace);
  });

  it('exports JSON through serializer-backed conversion so special values round-trip in pretty and compact modes', () => {
    const capturedAt = new Date('2026-05-05T12:34:56.789Z');
    const bytes = Buffer.from('export-payload');
    const specialTrace: Trace = {
      ...trace([
        span({
          id: 'span_special_0001',
          parentId: null,
          type: SpanType.Function,
          name: 'special payload',
          startTime: 1,
          duration: 2,
          input: {
            capturedAt,
            lookup: new Map<string, unknown>([['answer', 42]]),
            tags: new Set(['json', 'serializer']),
            bytes,
            missing: undefined
          },
          output: {
            completedAt: capturedAt,
            optional: undefined
          }
        })
      ]),
      metadata: {
        recordedAt: capturedAt,
        topLevelMissing: undefined
      }
    };

    for (const mode of ['pretty', 'compact'] as const) {
      const exported = exportJson(specialTrace, { mode });
      const revivedTrace = deserialize<Trace>(JSON.parse(exported));
      const [revivedSpan] = revivedTrace.spans;

      if (revivedSpan === undefined) {
        throw new Error('Expected one revived span');
      }

      const input = objectRecord(revivedSpan.input);
      const output = objectRecord(revivedSpan.output);

      expect(revivedTrace.metadata.recordedAt).toBeInstanceOf(Date);
      expect((revivedTrace.metadata.recordedAt as Date).toISOString()).toBe(capturedAt.toISOString());
      expect(Object.prototype.hasOwnProperty.call(revivedTrace.metadata, 'topLevelMissing')).toBe(true);
      expect(revivedTrace.metadata.topLevelMissing).toBeUndefined();

      expect(input.capturedAt).toBeInstanceOf(Date);
      expect((input.capturedAt as Date).toISOString()).toBe(capturedAt.toISOString());
      expect(input.lookup).toBeInstanceOf(Map);
      expect([...(input.lookup as Map<unknown, unknown>).entries()]).toEqual([['answer', 42]]);
      expect(input.tags).toBeInstanceOf(Set);
      expect([...(input.tags as Set<unknown>).values()]).toEqual(['json', 'serializer']);
      expect(Buffer.isBuffer(input.bytes)).toBe(true);
      expect((input.bytes as Buffer).toString('utf8')).toBe('export-payload');
      expect(Object.prototype.hasOwnProperty.call(input, 'missing')).toBe(true);
      expect(input.missing).toBeUndefined();

      expect(output.completedAt).toBeInstanceOf(Date);
      expect((output.completedAt as Date).toISOString()).toBe(capturedAt.toISOString());
      expect(Object.prototype.hasOwnProperty.call(output, 'optional')).toBe(true);
      expect(output.optional).toBeUndefined();
    }
  });

  it('exports Markdown with type icons, timing, parent-child indentation, and summary totals', () => {
    const markdown = exportMarkdown(sampleTrace);

    expect(markdown).toContain('# Trace: checkout <flow> "A&B"');
    expect(markdown).toContain('## Call Tree');
    expect(markdown).toContain('⚙️ `checkout <flow> "A&B"` (12ms)');
    expect(markdown).toMatch(/^  - 🌐 `GET \/api\/<orders>\?q="A&B"` \(4ms\).*status 200/mu);
    expect(markdown).toMatch(/^  - ⏱️ `setTimeout\(callback\)` \(1ms\)/mu);
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('| Total spans | 3 |');
    expect(markdown).toContain('| Total duration | 12ms |');
    expect(markdown).toContain('| ⚙️ function | 1 |');
    expect(markdown).toContain('| 🌐 http | 1 |');
    expect(markdown).toContain('| ⏱️ timer | 1 |');
  });

  it('exports Mermaid sequence diagrams and flowcharts with escaped special characters', () => {
    const sequence = exportMermaid(sampleTrace, { mode: 'sequence' });
    const flowchart = exportMermaid(sampleTrace, { mode: 'flowchart' });

    expect(sequence.startsWith('sequenceDiagram')).toBe(true);
    expect(sequence).toContain('participant span_0001');
    expect(sequence).toContain('participant span_0002');
    expect(sequence).toContain('span_0001->>span_0002:');
    expect(sequence).toContain('checkout &lt;flow&gt; &quot;A&amp;B&quot;');
    expect(sequence).not.toContain('checkout <flow> "A&B"');

    expect(flowchart.startsWith('flowchart TD')).toBe(true);
    expect(flowchart).toContain('span_0001[');
    expect(flowchart).toContain('span_0002[');
    expect(flowchart).toContain('span_0001 --> span_0002');
    expect(flowchart).toContain('GET /api/&lt;orders&gt;?q=&quot;A&amp;B&quot;');
    expect(flowchart).not.toContain('GET /api/<orders>?q="A&B"');
  });

  it('exports self-contained HTML with embedded parseable data and viewer structure', () => {
    const html = exportHtml(sampleTrace);
    const data = embeddedViewerData(html) as { readonly trace: Trace };

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/iu);
    expect(html).not.toMatch(/<link\b[^>]*\bhref=/iu);
    expect(html).not.toContain('https://');
    expect(data.trace.name).toBe(sampleTrace.name);
    expect(data.trace.spans).toHaveLength(3);

    expect(html).toContain('id="timeline"');
    expect(html).toContain('id="trace-tree"');
    expect(html).toContain('id="span-detail"');
    expect(html).toContain('id="type-filter"');
    expect(html).toContain('id="span-search"');
    expect(html).toContain('class="json-key"');
    expect(html).toContain('data-span-type="http"');
    expect(html).not.toContain('checkout <flow> "A&B"</title>');
  });

  it('exports large HTML traces and renders color-coded diff changes', () => {
    const largeSpans = Array.from({ length: 1005 }, (_item, index) => span({
      id: `span_large_${String(index).padStart(4, '0')}`,
      parentId: null,
      type: index % 2 === 0 ? SpanType.Function : SpanType.Http,
      name: `operation ${String(index)}`,
      startTime: index,
      duration: 1,
      output: { index }
    }));
    const largeTrace = {
      ...trace(largeSpans),
      id: 'trace_large_export',
      name: 'large export',
      endTime: 1006,
      duration: 1006
    };

    const largeHtml = exportHtml(largeTrace);
    const largeData = embeddedViewerData(largeHtml) as { readonly trace: Trace };

    expect(largeData.trace.spans).toHaveLength(1005);
    expect(largeHtml.length).toBeLessThan(50 * 1024 * 1024);

    const currentTrace = trace([
      {
        ...rootSpan,
        children: [
          {
            ...httpSpan,
            output: { status: 500 },
            metadata: { statusCode: 500 }
          }
        ]
      },
      {
        ...httpSpan,
        output: { status: 500 },
        metadata: { statusCode: 500 }
      },
      span({
        id: 'span_0004',
        parentId: null,
        type: SpanType.Db,
        name: 'SELECT orders',
        startTime: 9,
        duration: 2
      })
    ]);
    const diffResult = diff(sampleTrace, currentTrace);
    const diffHtml = exportHtml(currentTrace, { diff: diffResult });

    expect(diffHtml).toContain('id="diff-view"');
    expect(diffHtml).toContain('diff-added');
    expect(diffHtml).toContain('diff-removed');
    expect(diffHtml).toContain('diff-changed');
    expect(diffHtml).toContain('diff-severity-breaking');
  });

  it('applies HTML diff filters and transforms to the baseline trace before comparing', async () => {
    const baselineTrace = trace([
      httpSpan,
      timerSpan
    ]);
    const currentTrace = trace([
      {
        ...httpSpan,
        name: 'GET /api/orders?phase=current'
      }
    ]);
    const html = await exportTrace(currentTrace, {
      format: 'html',
      baselineTrace,
      filter: {
        types: [SpanType.Http]
      },
      transform: (filteredTrace) => ({
        ...filteredTrace,
        spans: filteredTrace.spans.map((selectedSpan) => ({
          ...selectedSpan,
          name: 'NORMALIZED HTTP'
        }))
      })
    });
    const data = embeddedViewerData(html) as { readonly diff: DiffResult | null };

    if (data.diff === null) {
      throw new Error('Expected computed diff data');
    }

    expect(data.diff.status).toBe('identical');
    expect(data.diff.stats.changed).toBe(0);
    expect(data.diff.stats.removed).toBe(0);
    expect(data.diff.changes).toEqual([]);
  });

  it('runs the export pipeline filter pass by type and time range', async () => {
    const byType = await exportTrace(sampleTrace, {
      format: 'json',
      filter: {
        types: [SpanType.Http]
      }
    });
    const byTypeTrace = JSON.parse(byType) as Trace;

    expect(byTypeTrace.spans.map((selectedSpan) => selectedSpan.type)).toEqual([SpanType.Http]);

    const flatTrace = trace([httpSpan, timerSpan]);
    const byTimeRange = await exportTrace(flatTrace, {
      format: 'json',
      filter: {
        timeRange: {
          start: 6,
          end: 9
        }
      }
    });
    const byTimeRangeTrace = JSON.parse(byTimeRange) as Trace;

    expect(byTimeRangeTrace.spans.map((selectedSpan) => selectedSpan.id)).toEqual(['span_0002', 'span_0003']);
  });

  it('includes spans that start or end exactly on time-range filter boundaries', async () => {
    const endsAtStart = span({
      id: 'span_ends_at_start',
      parentId: null,
      type: SpanType.Function,
      name: 'ends at lower boundary',
      startTime: 2,
      duration: 4
    });
    const startsAtEnd = span({
      id: 'span_starts_at_end',
      parentId: null,
      type: SpanType.Function,
      name: 'starts at upper boundary',
      startTime: 9,
      duration: 2
    });
    const beforeRange = span({
      id: 'span_before_range',
      parentId: null,
      type: SpanType.Function,
      name: 'before range',
      startTime: 1,
      duration: 4
    });
    const afterRange = span({
      id: 'span_after_range',
      parentId: null,
      type: SpanType.Function,
      name: 'after range',
      startTime: 10,
      duration: 2
    });
    const boundaryTrace = trace([beforeRange, endsAtStart, startsAtEnd, afterRange]);
    const exported = await exportTrace(boundaryTrace, {
      format: 'json',
      filter: {
        timeRange: {
          start: 6,
          end: 9
        }
      }
    });
    const filteredTrace = JSON.parse(exported) as Trace;

    expect(filteredTrace.spans.map((selectedSpan) => selectedSpan.id)).toEqual([
      'span_ends_at_start',
      'span_starts_at_end'
    ]);
  });

  it('applies transform passes after filtering and before formatting', async () => {
    let transformSawOnlyHttpSpans = false;
    const markdown = await exportTrace(sampleTrace, {
      format: 'markdown',
      filter: {
        types: [SpanType.Http]
      },
      transform: (filteredTrace) => {
        transformSawOnlyHttpSpans = filteredTrace.spans.every((selectedSpan) => selectedSpan.type === SpanType.Http);

        return {
          ...filteredTrace,
          spans: filteredTrace.spans.map((selectedSpan) => ({
            ...selectedSpan,
            name: 'REDACTED HTTP SPAN'
          }))
        };
      }
    });

    expect(transformSawOnlyHttpSpans).toBe(true);
    expect(markdown).toContain('REDACTED HTTP SPAN');
    expect(markdown).not.toContain('GET /api/<orders>');
    expect(markdown).not.toContain('setTimeout(callback)');
  });

  it('exportTrace returns strings, writes output files, and rejects unsupported formats descriptively', async () => {
    const returnedHtml = await exportTrace(sampleTrace, { format: 'html' });
    expect(returnedHtml).toContain('<!doctype html>');

    const directory = await mkdtemp(join(tmpdir(), 'ghosttrace-export-'));
    const outputPath = join(directory, 'trace.html');

    try {
      const writtenPath = await exportTrace(sampleTrace, {
        format: 'html',
        output: outputPath
      });
      const writtenHtml = await readFile(outputPath, 'utf8');

      expect(writtenPath).toBe(outputPath);
      expect(writtenHtml).toBe(returnedHtml);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    await expect(exportTrace(sampleTrace, { format: 'xml' as never })).rejects.toThrow(ExportError);
    await expect(exportTrace(sampleTrace, { format: 'xml' as never })).rejects.toThrow('json, markdown, mermaid, html');
  });
});
