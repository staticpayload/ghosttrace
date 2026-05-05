import { diff as diffTraces, type DiffChange, type DiffResult } from '../contract/diff.js';
import { type Span, type Trace } from '../core/types.js';
import { toSerializableTrace } from '../validation/canonical.js';
import { buildSpanTree, durationText, spanTypeCounts, typeIcon } from './shared.js';
import type { ExportHtmlOptions } from './types.js';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function htmlText(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);
}

function htmlAttribute(value: string): string {
  return htmlText(value);
}

function scriptJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</gu, '\\u003C')
    .replace(/>/gu, '\\u003E')
    .replace(/&/gu, '\\u0026')
    .replace(/\//gu, '\\u002F')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029');
}

function jsonBlock(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return htmlText(json ?? 'undefined');
}

function renderedDiffResult(trace: Trace, options: ExportHtmlOptions): DiffResult | undefined {
  if (options.diff !== undefined) {
    return options.diff;
  }

  if (options.baselineTrace !== undefined) {
    return diffTraces(options.baselineTrace, trace);
  }

  return undefined;
}

function renderDiffChange(change: DiffChange): string {
  const classes = `diff-change diff-${change.type} diff-severity-${change.severity}`;
  if (change.type === 'added') {
    return [
      `<li class="${classes}">`,
      '<strong>Added span</strong>',
      `<span>${htmlText(change.spanPath)} · ${htmlText(change.current.type)} · ${htmlText(change.current.name)}</span>`,
      `<pre>${jsonBlock(change.current)}</pre>`,
      '</li>'
    ].join('');
  }

  if (change.type === 'removed') {
    return [
      `<li class="${classes}">`,
      '<strong>Removed span</strong>',
      `<span>${htmlText(change.spanPath)} · ${htmlText(change.baseline.type)} · ${htmlText(change.baseline.name)}</span>`,
      `<pre>${jsonBlock(change.baseline)}</pre>`,
      '</li>'
    ].join('');
  }

  return [
    `<li class="${classes}">`,
    '<strong>Changed field</strong>',
    `<span>${htmlText(change.spanPath)} · ${htmlText(change.field)}</span>`,
    '<div class="diff-values">',
    `<pre><b>Baseline</b>\n${jsonBlock(change.baseline)}</pre>`,
    `<pre><b>Current</b>\n${jsonBlock(change.current)}</pre>`,
    '</div>',
    '</li>'
  ].join('');
}

function renderDiffView(diffResult: DiffResult | undefined): string {
  if (diffResult === undefined) {
    return [
      '<section id="diff-view" class="panel diff-view" aria-labelledby="diff-heading">',
      '<h2 id="diff-heading">Diff View</h2>',
      '<p class="empty-state">No diff result provided.</p>',
      '</section>'
    ].join('\n');
  }

  const warningItems = diffResult.warnings.map((warning) => `<li>${htmlText(warning.path)} — ${htmlText(warning.message)}</li>`);

  return [
    '<section id="diff-view" class="panel diff-view" aria-labelledby="diff-heading">',
    '<h2 id="diff-heading">Diff View</h2>',
    `<p class="diff-summary diff-status-${htmlAttribute(diffResult.status)}">${htmlText(diffResult.summary)}</p>`,
    '<dl class="diff-stats">',
    `<div><dt>Aligned</dt><dd>${String(diffResult.stats.aligned)}</dd></div>`,
    `<div><dt>Added</dt><dd>${String(diffResult.stats.added)}</dd></div>`,
    `<div><dt>Removed</dt><dd>${String(diffResult.stats.removed)}</dd></div>`,
    `<div><dt>Changed</dt><dd>${String(diffResult.stats.changed)}</dd></div>`,
    `<div><dt>Breaking</dt><dd>${String(diffResult.stats.breaking)}</dd></div>`,
    '</dl>',
    diffResult.changes.length === 0
      ? '<p class="empty-state">No changes detected.</p>'
      : `<ol class="diff-changes">${diffResult.changes.map(renderDiffChange).join('')}</ol>`,
    warningItems.length === 0 ? '' : `<h3>Warnings</h3><ul class="diff-warnings">${warningItems.join('')}</ul>`,
    '</section>'
  ].join('\n');
}

function htmlTypeControls(spans: readonly Span[]): string {
  const typeCounts = spanTypeCounts(spans);
  if (typeCounts.length === 0) {
    return '<p class="empty-state">No span types recorded.</p>';
  }

  return typeCounts.map(([type, count]) => [
    `<label class="type-filter-option" data-span-type="${htmlAttribute(type)}">`,
    `<input class="span-type-toggle" type="checkbox" value="${htmlAttribute(type)}" checked>`,
    `<span>${typeIcon(type)} ${htmlText(type)}</span>`,
    `<small>${String(count)}</small>`,
    '</label>'
  ].join('')).join('\n');
}

function htmlViewerScript(): string {
  return `
(function () {
  var dataNode = document.getElementById('ghosttrace-data');
  var viewerData = JSON.parse(dataNode && dataNode.textContent ? dataNode.textContent : '{"trace":{"spans":[]}}');
  var trace = viewerData.trace || { spans: [] };
  var spans = Array.isArray(trace.spans) ? trace.spans : [];
  var timeline = document.getElementById('timeline');
  var tree = document.getElementById('trace-tree');
  var detail = document.getElementById('span-detail');
  var search = document.getElementById('span-search');
  var toggles = Array.prototype.slice.call(document.querySelectorAll('.span-type-toggle'));
  var selectedTypes = new Set(toggles.map(function (toggle) { return toggle.value; }));
  var spansById = new Map(spans.map(function (span) { return [span.id, span]; }));

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || character;
    });
  }

  function normalizedText(value) {
    return JSON.stringify(value || '').toLowerCase();
  }

  function matchesSearch(span, query) {
    if (query.length === 0) {
      return true;
    }
    return [span.id, span.type, span.name, span.input, span.output, span.error, span.metadata].some(function (value) {
      return normalizedText(value).indexOf(query) !== -1;
    });
  }

  function filteredSpans() {
    var query = search ? search.value.trim().toLowerCase() : '';
    return spans.filter(function (span) {
      return selectedTypes.has(span.type) && matchesSearch(span, query);
    });
  }

  function syntaxHighlight(value) {
    var json = escapeHtml(JSON.stringify(value, null, 2));
    return json
      .replace(/(&quot;[^&]*&quot;)(\\s*:)/g, '<span class="json-key">$1</span>$2')
      .replace(/: (&quot;[^&]*&quot;)/g, ': <span class="json-string">$1</span>')
      .replace(/: (true|false|null|[-0-9.]+)/g, ': <span class="json-value">$1</span>');
  }

  function showDetail(span) {
    if (!detail || !span) {
      return;
    }
    detail.innerHTML = [
      '<h2>' + escapeHtml(span.name) + '</h2>',
      '<dl class="span-meta">',
      '<div><dt>ID</dt><dd>' + escapeHtml(span.id) + '</dd></div>',
      '<div><dt>Type</dt><dd>' + escapeHtml(span.type) + '</dd></div>',
      '<div><dt>Start</dt><dd>' + escapeHtml(span.startTime) + 'ms</dd></div>',
      '<div><dt>Duration</dt><dd>' + escapeHtml(span.duration) + 'ms</dd></div>',
      '</dl>',
      '<h3>Payload</h3>',
      '<pre class="json-detail">' + syntaxHighlight({
        input: span.input,
        output: span.output,
        error: span.error,
        metadata: span.metadata
      }) + '</pre>'
    ].join('');
  }

  function renderTimeline(list) {
    if (!timeline) {
      return;
    }
    var traceStart = Number.isFinite(trace.startTime) ? trace.startTime : 0;
    var traceDuration = Math.max(1, Number.isFinite(trace.duration) ? trace.duration : 1);
    timeline.innerHTML = list.map(function (span) {
      var left = Math.max(0, ((span.startTime - traceStart) / traceDuration) * 100);
      var width = Math.max(0.5, (Math.max(span.duration, 0.5) / traceDuration) * 100);
      return '<button class="timeline-bar span-type-' + escapeHtml(span.type) + '" data-span-id="' + escapeHtml(span.id) + '" style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%" title="' + escapeHtml(span.name) + '">' + escapeHtml(span.name) + '</button>';
    }).join('');
  }

  function childMap(list) {
    var ids = new Set(list.map(function (span) { return span.id; }));
    var map = new Map();
    list.forEach(function (span) {
      var parentId = ids.has(span.parentId) ? span.parentId : null;
      if (!map.has(parentId)) {
        map.set(parentId, []);
      }
      map.get(parentId).push(span);
    });
    return map;
  }

  function renderTreeNode(span, map) {
    var children = map.get(span.id) || [];
    return [
      '<details class="tree-node span-type-' + escapeHtml(span.type) + '" open>',
      '<summary><button type="button" data-span-id="' + escapeHtml(span.id) + '"><span>' + escapeHtml(span.type) + '</span> ' + escapeHtml(span.name) + ' <small>' + escapeHtml(span.duration) + 'ms</small></button></summary>',
      children.map(function (child) { return renderTreeNode(child, map); }).join(''),
      '</details>'
    ].join('');
  }

  function renderTree(list) {
    if (!tree) {
      return;
    }
    var map = childMap(list);
    var roots = map.get(null) || [];
    tree.innerHTML = roots.length === 0
      ? '<p class="empty-state">No spans match the current filters.</p>'
      : roots.map(function (span) { return renderTreeNode(span, map); }).join('');
  }

  function renderAll() {
    var list = filteredSpans();
    renderTimeline(list);
    renderTree(list);
    showDetail(list[0]);
  }

  toggles.forEach(function (toggle) {
    toggle.addEventListener('change', function () {
      if (toggle.checked) {
        selectedTypes.add(toggle.value);
      } else {
        selectedTypes.delete(toggle.value);
      }
      renderAll();
    });
  });

  if (search) {
    search.addEventListener('input', renderAll);
  }

  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target.closest('[data-span-id]') : null;
    if (!target) {
      return;
    }
    var span = spansById.get(target.getAttribute('data-span-id') || '');
    showDetail(span);
  });

  renderAll();
}());
`;
}

function htmlStyles(): string {
  return `
:root { color-scheme: light dark; --bg: #0f172a; --panel: #111827; --text: #e5e7eb; --muted: #94a3b8; --border: #334155; --accent: #60a5fa; --green: #22c55e; --red: #ef4444; --yellow: #facc15; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
header { padding: 24px 32px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, rgba(96,165,250,.18), rgba(34,197,94,.08)); }
h1, h2, h3 { margin: 0 0 12px; }
main { display: grid; grid-template-columns: minmax(260px, 360px) minmax(0, 1fr) minmax(300px, 420px); gap: 16px; padding: 16px; }
.panel { background: rgba(17, 24, 39, .92); border: 1px solid var(--border); border-radius: 14px; padding: 16px; min-width: 0; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
.controls { display: grid; gap: 12px; }
#span-search { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: #020617; color: var(--text); }
#type-filter { display: grid; gap: 8px; border: 0; padding: 0; margin: 0; }
.type-filter-option { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; }
.timeline { position: relative; height: 180px; overflow-x: hidden; border-radius: 12px; border: 1px solid var(--border); background: repeating-linear-gradient(90deg, rgba(148,163,184,.12), rgba(148,163,184,.12) 1px, transparent 1px, transparent 10%); }
.timeline-bar { position: absolute; top: 16px; min-width: 3px; height: 38px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; border: 0; border-radius: 8px; padding: 0 8px; color: #020617; background: var(--accent); cursor: pointer; }
.timeline-bar:nth-child(3n+2) { top: 64px; }
.timeline-bar:nth-child(3n+3) { top: 112px; }
.trace-tree { max-height: 64vh; overflow: auto; padding-right: 4px; }
.tree-node { margin: 4px 0 4px 16px; }
.tree-node summary { cursor: pointer; }
.tree-node button { border: 0; background: transparent; color: var(--text); cursor: pointer; text-align: left; padding: 4px 6px; border-radius: 8px; }
.tree-node button:hover { background: rgba(96,165,250,.14); }
.span-detail { overflow: auto; }
.span-meta, .diff-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 12px; }
.span-meta div, .diff-stats div { padding: 8px; border-radius: 10px; background: rgba(15, 23, 42, .8); }
dt { color: var(--muted); font-size: 12px; }
dd { margin: 0; overflow-wrap: anywhere; }
pre { overflow: auto; padding: 12px; border-radius: 10px; border: 1px solid var(--border); background: #020617; }
.json-key { color: #93c5fd; }
.json-string { color: #86efac; }
.json-value { color: #fde68a; }
.diff-view { grid-column: 1 / -1; }
.diff-summary { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); }
.diff-status-identical { border-color: var(--green); }
.diff-status-drift { border-color: var(--yellow); }
.diff-status-breaking { border-color: var(--red); }
.diff-changes { display: grid; gap: 12px; margin: 0; padding-left: 24px; }
.diff-change { border-left: 5px solid var(--border); padding: 12px; border-radius: 10px; background: rgba(15,23,42,.78); }
.diff-added { border-color: var(--green); }
.diff-removed { border-color: var(--red); }
.diff-changed { border-color: var(--yellow); }
.diff-severity-breaking { outline: 1px solid rgba(239,68,68,.55); }
.diff-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.empty-state { color: var(--muted); }
@media (max-width: 1100px) { main { grid-template-columns: 1fr; } .diff-values { grid-template-columns: 1fr; } }
`;
}

/** Exports a trace as a self-contained interactive HTML viewer with inline CSS, JS, and embedded JSON data. */
export function exportHtml(trace: Trace, options: ExportHtmlOptions = {}): string {
  const tree = buildSpanTree(trace);
  const diffResult = renderedDiffResult(trace, options);
  const viewerData = {
    trace: toSerializableTrace(trace),
    diff: diffResult ?? null
  };

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>GhostTrace Viewer · ${htmlText(trace.name)}</title>`,
    '<style>',
    htmlStyles(),
    '</style>',
    '</head>',
    '<body>',
    '<header>',
    `<h1>GhostTrace: ${htmlText(trace.name)}</h1>`,
    `<p><strong>ID:</strong> ${htmlText(trace.id)} · <strong>Duration:</strong> ${durationText(trace.duration)} · <strong>Spans:</strong> ${String(tree.spans.length)}</p>`,
    '</header>',
    '<main>',
    '<section class="panel controls" aria-labelledby="filters-heading">',
    '<h2 id="filters-heading">Filters</h2>',
    '<label for="span-search">Text search</label>',
    '<input id="span-search" data-testid="text-search" type="search" placeholder="Search names, IDs, payloads">',
    '<fieldset id="type-filter" data-testid="type-filter">',
    '<legend>Span types</legend>',
    htmlTypeControls(tree.spans),
    '</fieldset>',
    '</section>',
    '<section class="panel" aria-labelledby="timeline-heading">',
    '<h2 id="timeline-heading">Interactive Timeline</h2>',
    '<div id="timeline" class="timeline" data-testid="timeline" role="list"></div>',
    '<h2>Collapsible Tree</h2>',
    '<div id="trace-tree" class="trace-tree" data-testid="call-tree"></div>',
    '</section>',
    '<aside id="span-detail" class="panel span-detail" data-testid="span-detail" aria-live="polite">',
    '<h2>Span Detail</h2>',
    '<p class="empty-state">Select a span to inspect serialized input, output, error, and metadata.</p>',
    '</aside>',
    renderDiffView(diffResult),
    '</main>',
    `<script id="ghosttrace-data" type="application/json">${scriptJson(viewerData)}</script>`,
    '<script>',
    htmlViewerScript(),
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');
}
