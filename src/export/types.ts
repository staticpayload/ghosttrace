import type { DiffResult } from '../contract/diff.js';
import { SpanType, type Trace } from '../core/types.js';

/** JSON output density used by exportJson(). */
export type JsonExportMode = 'pretty' | 'compact';

/** Mermaid diagram shape emitted by exportMermaid(). */
export type MermaidExportMode = 'sequence' | 'flowchart';

/** Export format selected by exportTrace(). */
export type TraceExportFormat = 'json' | 'markdown' | 'mermaid' | 'html';

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

/** Time range used by the export pipeline's filtering pass. */
export interface ExportTimeRange {
  /** Inclusive lower bound in trace-relative milliseconds. */
  readonly start?: number;
  /** Inclusive upper bound in trace-relative milliseconds. */
  readonly end?: number;
}

/** Filter used by the export pipeline before transforms and formatting. */
export interface TraceExportFilter {
  /** Single span type to include. */
  readonly type?: SpanType | string;
  /** Span types to include. */
  readonly types?: readonly (SpanType | string)[];
  /** Trace-relative time range; spans are selected when their interval overlaps it. */
  readonly timeRange?: ExportTimeRange;
}

/** Transform function used by the export pipeline after filtering and before formatting. */
export type TraceExportTransform = (trace: Trace) => Trace | void;

/** Shared options for the export pipeline filter and transform passes. */
export interface ExportPipelineOptions {
  /** Optional span filter applied before transforms. */
  readonly filter?: TraceExportFilter;
  /** One or more transforms applied before the formatter runs. */
  readonly transform?: TraceExportTransform | readonly TraceExportTransform[];
}

/** Options controlling self-contained HTML viewer export. */
export interface ExportHtmlOptions {
  /** Precomputed diff result to render in the viewer's diff panel. */
  readonly diff?: DiffResult;
  /** Optional baseline trace; when provided, a diff is computed against the exported trace. */
  readonly baselineTrace?: Trace;
}

/** Options accepted by exportTrace(). */
export interface ExportTraceOptions extends ExportPipelineOptions, ExportHtmlOptions {
  /** Output format to produce. */
  readonly format: TraceExportFormat;
  /** Optional output file path. When omitted, the formatted string is returned. */
  readonly output?: string;
  /** Convenience mode forwarded to JSON or Mermaid formatters. */
  readonly mode?: JsonExportMode | MermaidExportMode;
  /** Format-specific JSON options. */
  readonly json?: ExportJsonOptions;
  /** Format-specific Mermaid options. */
  readonly mermaid?: ExportMermaidOptions;
  /** Format-specific HTML options. */
  readonly html?: ExportHtmlOptions;
}
