import { ExportError } from '../core/errors.js';
import { SpanType, type Span, type Trace } from '../core/types.js';
import { toSerializableTrace } from '../validation/canonical.js';

/** JSON output density used by exportJson(). */
export type JsonExportMode = 'pretty' | 'compact';

/** Mermaid diagram shape emitted by exportMermaid(). */
export type MermaidExportMode = 'sequence' | 'flowchart';

/** Options controlling JSON trace export. */
export interface ExportJsonOptions {
  /** Pretty emits two-space indentation; compact emits a single-line JSON document. */
  readonly mode?: JsonExportMode;
}

/** Options controlling Mermaid trace export. */
export interface ExportMermaidOptions {
  /** Sequence diagrams show participants/arrows; flowcharts show call-tree nodes/edges. */
  readonly mode?: MermaidExportMode;
}

interface TreeNode {
  readonly span: Span;
  readonly children: readonly TreeNode[];
}

interface SpanTree {
  readonly roots: readonly TreeNode[];
  readonly spans: readonly Span[];
}

const TYPE_ICONS: Readonly<Record<SpanType, string>> = {
  [SpanType.Function]: '⚙️',
  [SpanType.Http]: '🌐',
  [SpanType.Timer]: '⏱️',
  [SpanType.Random]: '🎲',
  [SpanType.Env]: '🌱',
  [SpanType.Fs]: '📁',
  [SpanType.Db]: '🗄️',
  [SpanType.Queue]: '📬',
  [SpanType.Error]: '⚠️',
  [SpanType.Performance]: '📈'
};

const SPAN_TYPE_ORDER: readonly SpanType[] = [
  SpanType.Function,
  SpanType.Http,
  SpanType.Timer,
  SpanType.Random,
  SpanType.Env,
  SpanType.Fs,
  SpanType.Db,
  SpanType.Queue,
  SpanType.Error,
  SpanType.Performance
];

const MERMAID_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '[': '&#91;',
  ']': '&#93;',
  '{': '&#123;',
  '}': '&#125;',
  '|': '&#124;'
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeJsonMode(trace: Trace, mode: JsonExportMode | undefined): JsonExportMode {
  if (mode === undefined) {
    return 'pretty';
  }
  if (mode === 'pretty' || mode === 'compact') {
    return mode;
  }

  throw new ExportError(`Unsupported JSON export mode "${String(mode)}". Expected pretty or compact.`, {
    traceId: trace.id,
    context: { mode: String(mode) }
  });
}

function normalizeMermaidMode(trace: Trace, mode: MermaidExportMode | undefined): MermaidExportMode {
  if (mode === undefined) {
    return 'sequence';
  }
  if (mode === 'sequence' || mode === 'flowchart') {
    return mode;
  }

  throw new ExportError(`Unsupported Mermaid export mode "${String(mode)}". Expected sequence or flowchart.`, {
    traceId: trace.id,
    context: { mode: String(mode) }
  });
}

function typeIcon(type: SpanType): string {
  return TYPE_ICONS[type] ?? '•';
}

function durationText(durationMs: number): string {
  if (!Number.isFinite(durationMs)) {
    return 'unknown';
  }

  if (Number.isInteger(durationMs)) {
    return `${durationMs}ms`;
  }

  return `${durationMs.toFixed(3).replace(/\.?0+$/u, '')}ms`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
}

function markdownInlineCode(value: string): string {
  const normalized = singleLine(value);
  if (!normalized.includes('`')) {
    return `\`${normalized}\``;
  }

  return `\`\` ${normalized.replace(/`/gu, '\\`')} \`\``;
}

function markdownTableText(value: string): string {
  return singleLine(value).replace(/\|/gu, '\\|');
}

function mermaidText(value: string): string {
  return singleLine(value).replace(/[&<>"'`\[\]{}|]/gu, (character) => MERMAID_ESCAPES[character] ?? character);
}

function mermaidQuoted(value: string): string {
  return `"${mermaidText(value)}"`;
}

function statusFromValue(value: unknown): string | number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const status = value.status ?? value.statusCode;
  if (typeof status === 'string' || typeof status === 'number') {
    return status;
  }

  return undefined;
}

function spanStatus(span: Span): string | undefined {
  const status = statusFromValue(span.metadata) ?? statusFromValue(span.output);
  if (status !== undefined) {
    return `status ${String(status)}`;
  }
  if (span.error !== null) {
    return `error ${span.error.message}`;
  }

  return undefined;
}

function collectUniqueSpans(trace: Trace): readonly Span[] {
  const spansById = new Map<string, Span>();

  const visit = (span: Span): void => {
    if (spansById.has(span.id)) {
      return;
    }

    spansById.set(span.id, span);
    for (const child of span.children) {
      visit(child);
    }
  };

  for (const span of trace.spans) {
    visit(span);
  }

  return Array.from(spansById.values()).sort((left, right) => left.startTime - right.startTime);
}

function sortedChildren(spans: readonly Span[]): readonly Span[] {
  return [...spans].sort((left, right) => left.startTime - right.startTime || left.id.localeCompare(right.id));
}

function buildTreeNode(
  span: Span,
  childrenByParentId: ReadonlyMap<string, readonly Span[]>,
  ancestry: ReadonlySet<string>
): TreeNode {
  if (ancestry.has(span.id)) {
    return {
      span,
      children: []
    };
  }

  const nextAncestry = new Set(ancestry);
  nextAncestry.add(span.id);

  return {
    span,
    children: sortedChildren(childrenByParentId.get(span.id) ?? []).map((child) => buildTreeNode(child, childrenByParentId, nextAncestry))
  };
}

function buildSpanTree(trace: Trace): SpanTree {
  const spans = collectUniqueSpans(trace);
  const spanIds = new Set(spans.map((span) => span.id));
  const childrenByParentId = new Map<string, Span[]>();

  for (const span of spans) {
    if (span.parentId === null || !spanIds.has(span.parentId)) {
      continue;
    }

    const existing = childrenByParentId.get(span.parentId) ?? [];
    existing.push(span);
    childrenByParentId.set(span.parentId, existing);
  }

  const roots = spans.filter((span) => span.parentId === null || !spanIds.has(span.parentId));

  return {
    spans,
    roots: sortedChildren(roots).map((span) => buildTreeNode(span, childrenByParentId, new Set()))
  };
}

function renderMarkdownNode(node: TreeNode, depth: number): readonly string[] {
  const status = spanStatus(node.span);
  const suffix = status === undefined ? '' : ` — ${status}`;
  const line = `${'  '.repeat(depth)}- ${typeIcon(node.span.type)} ${markdownInlineCode(node.span.name)} (${durationText(node.span.duration)})${suffix}`;

  return [
    line,
    ...node.children.flatMap((child) => renderMarkdownNode(child, depth + 1))
  ];
}

function spanTypeCounts(spans: readonly Span[]): readonly [SpanType, number][] {
  const counts = new Map<SpanType, number>();

  for (const span of spans) {
    counts.set(span.type, (counts.get(span.type) ?? 0) + 1);
  }

  return SPAN_TYPE_ORDER.flatMap((type) => {
    const count = counts.get(type);
    return count === undefined ? [] : [[type, count] as const];
  });
}

function spanLabel(span: Span): string {
  const status = spanStatus(span);
  const suffix = status === undefined ? '' : ` — ${status}`;
  return `${typeIcon(span.type)} ${span.name} (${durationText(span.duration)})${suffix}`;
}

function safeMermaidId(span: Span, usedIds: Set<string>): string {
  const sanitized = span.id.replace(/[^A-Za-z0-9_]/gu, '_').replace(/^[^A-Za-z_]+/u, '');
  const baseId = sanitized.length === 0 ? 'span' : sanitized;
  let id = baseId;
  let suffix = 2;

  while (usedIds.has(id)) {
    id = `${baseId}_${suffix}`;
    suffix += 1;
  }

  usedIds.add(id);
  return id;
}

function mermaidIds(spans: readonly Span[]): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  const usedIds = new Set<string>(['trace']);

  for (const span of spans) {
    ids.set(span.id, safeMermaidId(span, usedIds));
  }

  return ids;
}

function requireMermaidId(ids: ReadonlyMap<string, string>, span: Span): string {
  return ids.get(span.id) ?? span.id;
}

function renderSequenceEdges(node: TreeNode, ids: ReadonlyMap<string, string>): readonly string[] {
  const sourceId = requireMermaidId(ids, node.span);
  const lines: string[] = [];

  for (const child of node.children) {
    const targetId = requireMermaidId(ids, child.span);
    lines.push(`${sourceId}->>${targetId}: ${mermaidText(spanLabel(child.span))}`);
    lines.push(`${targetId}-->>${sourceId}: ${mermaidText(child.span.error === null ? `done (${durationText(child.span.duration)})` : `error ${child.span.error.message}`)}`);
    lines.push(...renderSequenceEdges(child, ids));
  }

  return lines;
}

function renderFlowchartEdges(node: TreeNode, ids: ReadonlyMap<string, string>): readonly string[] {
  const sourceId = requireMermaidId(ids, node.span);
  const lines: string[] = [];

  for (const child of node.children) {
    const targetId = requireMermaidId(ids, child.span);
    lines.push(`  ${sourceId} --> ${targetId}`);
    lines.push(...renderFlowchartEdges(child, ids));
  }

  return lines;
}

function renderMermaidSequence(trace: Trace): string {
  const tree = buildSpanTree(trace);
  const ids = mermaidIds(tree.spans);
  const lines = [
    'sequenceDiagram',
    `participant trace as ${mermaidQuoted(`Trace: ${trace.name}`)}`
  ];

  for (const span of tree.spans) {
    lines.push(`participant ${requireMermaidId(ids, span)} as ${mermaidQuoted(`${typeIcon(span.type)} ${span.name}`)}`);
  }

  for (const root of tree.roots) {
    const rootId = requireMermaidId(ids, root.span);
    lines.push(`trace->>${rootId}: ${mermaidText(spanLabel(root.span))}`);
    lines.push(...renderSequenceEdges(root, ids));
  }

  return `${lines.join('\n')}\n`;
}

function renderMermaidFlowchart(trace: Trace): string {
  const tree = buildSpanTree(trace);
  const ids = mermaidIds(tree.spans);
  const lines = [
    'flowchart TD',
    `  trace[${mermaidQuoted(`Trace: ${trace.name}`)}]`
  ];

  for (const span of tree.spans) {
    lines.push(`  ${requireMermaidId(ids, span)}[${mermaidQuoted(spanLabel(span))}]`);
  }

  for (const root of tree.roots) {
    lines.push(`  trace --> ${requireMermaidId(ids, root.span)}`);
    lines.push(...renderFlowchartEdges(root, ids));
  }

  return `${lines.join('\n')}\n`;
}

/** Exports a trace as JSON using either two-space pretty output or compact single-line output. */
export function exportJson<TSpan extends Span>(trace: Trace<TSpan>, options: ExportJsonOptions = {}): string {
  const serializableTrace = toSerializableTrace(trace);
  return normalizeJsonMode(trace, options.mode) === 'pretty'
    ? `${JSON.stringify(serializableTrace, null, 2)}\n`
    : JSON.stringify(serializableTrace);
}

/** Exports a trace as Markdown with a hierarchical call tree and timing summary. */
export function exportMarkdown(trace: Trace): string {
  const tree = buildSpanTree(trace);
  const failedSpans = tree.spans.filter((span) => span.error !== null).length;
  const successfulSpans = tree.spans.length - failedSpans;
  const lines = [
    `# Trace: ${trace.name}`,
    '',
    `- **ID:** ${trace.id}`,
    `- **Duration:** ${durationText(trace.duration)}`,
    `- **Spans:** ${String(tree.spans.length)}`,
    '',
    '## Call Tree',
    '',
    ...(tree.roots.length === 0 ? ['_No spans recorded._'] : tree.roots.flatMap((root) => renderMarkdownNode(root, 0))),
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Total spans | ${String(tree.spans.length)} |`,
    `| Total duration | ${durationText(trace.duration)} |`,
    `| Successful spans | ${String(successfulSpans)} |`,
    `| Failed spans | ${String(failedSpans)} |`,
    '',
    '### Counts by type',
    '',
    '| Type | Count |',
    '| --- | ---: |',
    ...spanTypeCounts(tree.spans).map(([type, count]) => `| ${markdownTableText(`${typeIcon(type)} ${type}`)} | ${String(count)} |`)
  ];

  return `${lines.join('\n')}\n`;
}

/** Exports a trace as a Mermaid sequence diagram or flowchart. */
export function exportMermaid(trace: Trace, options: ExportMermaidOptions = {}): string {
  return normalizeMermaidMode(trace, options.mode) === 'sequence'
    ? renderMermaidSequence(trace)
    : renderMermaidFlowchart(trace);
}
