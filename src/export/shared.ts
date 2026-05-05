import { ExportError } from '../core/errors.js';
import { SpanType, type Span, type Trace } from '../core/types.js';
import { toSerializableTrace } from '../validation/canonical.js';
import type { JsonExportMode, MermaidExportMode } from './types.js';

export interface TreeNode {
  readonly span: Span;
  readonly children: readonly TreeNode[];
}

export interface SpanTree {
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

export const SPAN_TYPE_ORDER: readonly SpanType[] = [
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

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeJsonMode(trace: Trace, mode: JsonExportMode | undefined): JsonExportMode {
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

export function normalizeMermaidMode(trace: Trace, mode: MermaidExportMode | undefined): MermaidExportMode {
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

export function typeIcon(type: SpanType): string {
  return TYPE_ICONS[type] ?? '•';
}

export function durationText(durationMs: number): string {
  if (!Number.isFinite(durationMs)) {
    return 'unknown';
  }

  if (Number.isInteger(durationMs)) {
    return `${durationMs}ms`;
  }

  return `${durationMs.toFixed(3).replace(/\.?0+$/u, '')}ms`;
}

export function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim();
}

export function markdownInlineCode(value: string): string {
  const normalized = singleLine(value);
  if (!normalized.includes('`')) {
    return `\`${normalized}\``;
  }

  return `\`\` ${normalized.replace(/`/gu, '\\`')} \`\``;
}

export function markdownTableText(value: string): string {
  return singleLine(value).replace(/\|/gu, '\\|');
}

export function mermaidText(value: string): string {
  return singleLine(value).replace(/[&<>"'`\[\]{}|]/gu, (character) => MERMAID_ESCAPES[character] ?? character);
}

export function mermaidQuoted(value: string): string {
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

export function spanStatus(span: Span): string | undefined {
  const status = statusFromValue(span.metadata) ?? statusFromValue(span.output);
  if (status !== undefined) {
    return `status ${String(status)}`;
  }
  if (span.error !== null) {
    return `error ${span.error.message}`;
  }

  return undefined;
}

export function collectUniqueSpans(trace: Trace): readonly Span[] {
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

export function cloneSpan(span: Span, includedIds?: ReadonlySet<string>): Span {
  const children = span.children
    .filter((child) => includedIds === undefined || includedIds.has(child.id))
    .map((child) => cloneSpan(child, includedIds));

  return {
    ...span,
    children
  };
}

export function cloneTrace(trace: Trace): Trace {
  return {
    ...toSerializableTrace(trace),
    spans: collectUniqueSpans(trace).map((span) => cloneSpan(span))
  };
}

export function sortedChildren(spans: readonly Span[]): readonly Span[] {
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

export function buildSpanTree(trace: Trace): SpanTree {
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

export function renderMarkdownNode(node: TreeNode, depth: number): readonly string[] {
  const status = spanStatus(node.span);
  const suffix = status === undefined ? '' : ` — ${status}`;
  const line = `${'  '.repeat(depth)}- ${typeIcon(node.span.type)} ${markdownInlineCode(node.span.name)} (${durationText(node.span.duration)})${suffix}`;

  return [
    line,
    ...node.children.flatMap((child) => renderMarkdownNode(child, depth + 1))
  ];
}

export function spanTypeCounts(spans: readonly Span[]): readonly [SpanType, number][] {
  const counts = new Map<SpanType, number>();

  for (const span of spans) {
    counts.set(span.type, (counts.get(span.type) ?? 0) + 1);
  }

  return SPAN_TYPE_ORDER.flatMap((type) => {
    const count = counts.get(type);
    return count === undefined ? [] : [[type, count] as const];
  });
}

export function spanLabel(span: Span): string {
  const status = spanStatus(span);
  const suffix = status === undefined ? '' : ` — ${status}`;
  return `${typeIcon(span.type)} ${span.name} (${durationText(span.duration)})${suffix}`;
}
