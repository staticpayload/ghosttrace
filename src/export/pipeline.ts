import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { DiffResult } from '../contract/diff.js';
import { ExportError } from '../core/errors.js';
import { type GhostTraceConfig, type Span, type Trace } from '../core/types.js';
import { toSerializableTrace } from '../validation/canonical.js';
import { createPluginRuntime, runTracePluginHooks } from '../plugins/index.js';
import { exportHtml } from './html.js';
import { exportJson, exportMarkdown, exportMermaid } from './formatters.js';
import { cloneSpan, cloneTrace, collectUniqueSpans } from './shared.js';
import type {
  ExportPipelineOptions,
  ExportTimeRange,
  ExportTraceOptions,
  JsonExportMode,
  MermaidExportMode,
  TraceExportFilter,
  TraceExportFormat,
  TraceExportTransform
} from './types.js';

const EXPORT_FORMATS: readonly TraceExportFormat[] = ['json', 'markdown', 'mermaid', 'html'];

function configFromExportOptions(options: ExportTraceOptions): GhostTraceConfig {
  const config: {
    plugins?: NonNullable<ExportTraceOptions['plugins']>;
  } = {};

  if (options.plugins !== undefined) {
    config.plugins = options.plugins;
  }

  return config;
}

function normalizeExportFormat(trace: Trace, format: TraceExportFormat | string): TraceExportFormat {
  if (EXPORT_FORMATS.includes(format as TraceExportFormat)) {
    return format as TraceExportFormat;
  }

  throw new ExportError(`Unsupported export format "${String(format)}". Expected one of: ${EXPORT_FORMATS.join(', ')}.`, {
    traceId: trace.id,
    context: { format: String(format), validFormats: [...EXPORT_FORMATS] }
  });
}

function normalizedFilterTypes(filter: TraceExportFilter | undefined): ReadonlySet<string> {
  const types = new Set<string>();

  if (filter?.type !== undefined) {
    types.add(filter.type);
  }

  for (const type of filter?.types ?? []) {
    types.add(type);
  }

  return types;
}

function spanOverlapsRange(span: Span, range: ExportTimeRange | undefined, trace: Trace): boolean {
  if (range === undefined) {
    return true;
  }

  const start = range.start ?? Number.NEGATIVE_INFINITY;
  const end = range.end ?? Number.POSITIVE_INFINITY;

  if (start > end) {
    throw new ExportError('Invalid export time range: start must be less than or equal to end.', {
      traceId: trace.id,
      context: { start, end }
    });
  }

  if (span.duration === 0) {
    return span.startTime >= start && span.startTime <= end;
  }

  return span.endTime >= start && span.startTime <= end;
}

function spanMatchesExportFilter(span: Span, filter: TraceExportFilter | undefined, trace: Trace): boolean {
  const types = normalizedFilterTypes(filter);
  if (types.size > 0 && !types.has(span.type)) {
    return false;
  }

  return spanOverlapsRange(span, filter?.timeRange, trace);
}

function normalizedTransforms(transform: ExportPipelineOptions['transform']): readonly TraceExportTransform[] {
  if (transform === undefined) {
    return [];
  }

  return typeof transform === 'function' ? [transform] : transform;
}

/** Applies the export pipeline's filter pass and returns a detached trace copy. */
export function filterTraceForExport(trace: Trace, filter?: TraceExportFilter): Trace {
  if (filter === undefined) {
    return cloneTrace(trace);
  }

  const selectedSpans = collectUniqueSpans(trace).filter((span) => spanMatchesExportFilter(span, filter, trace));
  const selectedIds = new Set(selectedSpans.map((span) => span.id));

  return {
    ...toSerializableTrace(trace),
    spans: selectedSpans.map((span) => cloneSpan(span, selectedIds))
  };
}

/** Runs the export pipeline as filter → transform and returns the trace passed to formatters. */
export function applyExportPipeline(trace: Trace, options: ExportPipelineOptions = {}): Trace {
  let currentTrace = filterTraceForExport(trace, options.filter);

  for (const transform of normalizedTransforms(options.transform)) {
    currentTrace = transform(currentTrace) ?? currentTrace;
  }

  return currentTrace;
}

function exportTraceContent(trace: Trace, options: ExportTraceOptions, format: TraceExportFormat): string {
  if (format === 'json') {
    const mode = options.json?.mode ?? (options.mode as JsonExportMode | undefined);
    return exportJson(trace, mode === undefined ? {} : { mode });
  }

  if (format === 'markdown') {
    return exportMarkdown(trace);
  }

  if (format === 'mermaid') {
    const mode = options.mermaid?.mode ?? (options.mode as MermaidExportMode | undefined);
    return exportMermaid(trace, mode === undefined ? {} : { mode });
  }

  const htmlOptions: {
    diff?: DiffResult;
    baselineTrace?: Trace;
  } = {};
  const diffResult = options.html?.diff ?? options.diff;
  const baselineTrace = options.html?.baselineTrace ?? options.baselineTrace;

  if (diffResult !== undefined) {
    htmlOptions.diff = diffResult;
  }
  if (baselineTrace !== undefined) {
    htmlOptions.baselineTrace = applyExportPipeline(baselineTrace, options);
  }

  return exportHtml(trace, htmlOptions);
}

async function writeExportFile(trace: Trace, outputPath: string, content: string): Promise<string> {
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, 'utf8');
    return outputPath;
  } catch (cause) {
    throw new ExportError(`Failed to write export output to "${outputPath}".`, {
      traceId: trace.id,
      context: { outputPath },
      cause
    });
  }
}

/** Runs the export pipeline and either returns the formatted string or writes it to the configured output path. */
export async function exportTrace(trace: Trace, options: ExportTraceOptions): Promise<string> {
  const format = normalizeExportFormat(trace, options.format);
  const pluginRuntimeOptions: {
    plugins?: NonNullable<ExportTraceOptions['plugins']>;
    pluginContext?: NonNullable<ExportTraceOptions['pluginContext']>;
    config: GhostTraceConfig;
  } = {
    config: configFromExportOptions(options)
  };
  if (options.plugins !== undefined) {
    pluginRuntimeOptions.plugins = options.plugins;
  }
  if (options.pluginContext !== undefined) {
    pluginRuntimeOptions.pluginContext = options.pluginContext;
  }
  const pluginRuntime = createPluginRuntime(pluginRuntimeOptions);
  const pipelineTrace = applyExportPipeline(trace, options);
  const exportReadyTrace = await runTracePluginHooks(pluginRuntime, 'beforeExport', pipelineTrace, {
    operation: 'export',
    format
  });
  const content = exportTraceContent(exportReadyTrace, options, format);

  if (options.output !== undefined) {
    return writeExportFile(exportReadyTrace, options.output, content);
  }

  return content;
}
