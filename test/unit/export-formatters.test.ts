import { describe, expect, it } from 'vitest';
import {
  SpanType,
  TRACE_FORMAT_VERSION,
  exportJson,
  exportMarkdown,
  exportMermaid,
  type Span,
  type Trace
} from '../../src/index.js';

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

describe('export formatters', () => {
  it('exports pretty and compact JSON that round-trip to the same trace data', () => {
    const pretty = exportJson(sampleTrace, { mode: 'pretty' });
    const compact = exportJson(sampleTrace, { mode: 'compact' });

    expect(pretty).toContain('\n');
    expect(pretty).toContain('\n  "id": "trace_export_test"');
    expect(compact).not.toContain('\n');
    expect(JSON.parse(pretty) as Trace).toEqual(sampleTrace);
    expect(JSON.parse(compact) as Trace).toEqual(sampleTrace);
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
});
