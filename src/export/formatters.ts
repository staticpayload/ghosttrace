import { type Span, type Trace } from '../core/types.js';
import { canonicalJsonStringify, toSerializableTrace } from '../validation/canonical.js';
import {
  buildSpanTree,
  durationText,
  markdownTableText,
  mermaidQuoted,
  mermaidText,
  normalizeJsonMode,
  normalizeMermaidMode,
  renderMarkdownNode,
  spanLabel,
  spanTypeCounts,
  typeIcon,
  type TreeNode
} from './shared.js';
import type { ExportJsonOptions, ExportMermaidOptions } from './types.js';

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
  const compactJson = canonicalJsonStringify(toSerializableTrace(trace));
  return normalizeJsonMode(trace, options.mode) === 'pretty'
    ? `${JSON.stringify(JSON.parse(compactJson), null, 2)}\n`
    : compactJson;
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
