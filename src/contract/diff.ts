import { type Span, type Trace } from '../core/types.js';

/** Overall contract comparison status. */
export type DiffStatus = 'identical' | 'drift' | 'breaking';

/** Kind of structural change found between two traces. */
export type DiffChangeType = 'added' | 'removed' | 'changed';

/** Severity assigned to a contract diff change. */
export type DiffChangeSeverity = 'drift' | 'breaking';

/** Context passed to custom diff comparators. */
export interface DiffComparatorContext {
  /** Absolute JSONPath-like path to the compared field. */
  readonly path: string;
  /** JSONPath-like path to the aligned span being compared. */
  readonly spanPath: string;
  /** Field path relative to the span. */
  readonly field: string;
  /** Baseline span containing the compared field. */
  readonly baselineSpan: Span;
  /** Current span containing the compared field. */
  readonly currentSpan: Span;
}

/** Custom comparator for one diff field. Return true when values should be treated as equal. */
export type DiffComparator = (
  baseline: unknown,
  current: unknown,
  context: DiffComparatorContext
) => boolean;

/** Rules that control filtering and severity during contract diffing. */
export interface DiffOptions {
  /** JSONPath-like paths or span-relative fields to exclude from the result. */
  readonly ignorePaths?: readonly string[];
  /** Treat spans present only in the current trace as non-breaking drift. Defaults to false. */
  readonly allowNewSpans?: boolean;
  /** Treat spans missing from the current trace as non-breaking drift. Defaults to false. */
  readonly allowRemovedSpans?: boolean;
  /** JSONPath-like paths or span-relative fields that should be classified as breaking. */
  readonly breakingOn?: readonly string[];
  /** Field-specific comparators keyed by JSONPath-like path or span-relative field. */
  readonly comparators?: Readonly<Record<string, DiffComparator>>;
}

/** Warning emitted while comparing traces. */
export interface DiffWarning {
  /** Absolute path affected by the warning. */
  readonly path: string;
  /** Human-readable warning text. */
  readonly message: string;
  /** Comparator rule that emitted the warning, when applicable. */
  readonly comparatorPath?: string;
  /** Span path affected by the warning, when applicable. */
  readonly spanPath?: string;
  /** Field path affected by the warning, when applicable. */
  readonly field?: string;
}

interface BaseDiffChange {
  readonly type: DiffChangeType;
  readonly spanPath: string;
  readonly field: string;
  readonly severity: DiffChangeSeverity;
}

/** Span present only in the current trace. */
export interface AddedSpanChange extends BaseDiffChange {
  readonly type: 'added';
  readonly current: Span;
}

/** Span present only in the baseline trace. */
export interface RemovedSpanChange extends BaseDiffChange {
  readonly type: 'removed';
  readonly baseline: Span;
}

/** Field value changed on an aligned span. */
export interface ChangedFieldChange extends BaseDiffChange {
  readonly type: 'changed';
  readonly baseline: unknown;
  readonly current: unknown;
}

/** One structural contract diff change. */
export type DiffChange = AddedSpanChange | RemovedSpanChange | ChangedFieldChange;

/** Aggregated change counts for a trace diff. */
export interface DiffStats {
  /** Number of span pairs aligned by LCS. */
  readonly aligned: number;
  /** Number of span additions. */
  readonly added: number;
  /** Number of span removals. */
  readonly removed: number;
  /** Number of aligned field changes. */
  readonly changed: number;
  /** Number of non-breaking drift changes. */
  readonly drift: number;
  /** Number of breaking changes. */
  readonly breaking: number;
  /** Total number of change entries. */
  readonly total: number;
}

/** Result returned by the structural contract diff engine. */
export interface DiffResult {
  /** Overall status derived from the emitted changes. */
  readonly status: DiffStatus;
  /** Human-readable summary containing the same counts as stats. */
  readonly summary: string;
  /** Structural additions, removals, and field changes. */
  readonly changes: readonly DiffChange[];
  /** Non-fatal warnings produced while comparing. */
  readonly warnings: readonly DiffWarning[];
  /** Aggregated counts for aligned spans and change severities. */
  readonly stats: DiffStats;
}

type Alignment =
  | {
      readonly kind: 'matched';
      readonly baselineIndex: number;
      readonly currentIndex: number;
      readonly baseline: Span;
      readonly current: Span;
    }
  | {
      readonly kind: 'added';
      readonly currentIndex: number;
      readonly current: Span;
    }
  | {
      readonly kind: 'removed';
      readonly baselineIndex: number;
      readonly baseline: Span;
    };

interface ComparatorMatch {
  readonly rule: string;
  readonly comparator: DiffComparator;
}

interface CompareState {
  readonly options: DiffOptions;
  readonly changes: DiffChange[];
  readonly warnings: DiffWarning[];
}

const COMPARED_SPAN_FIELDS = [
  'parentId',
  'type',
  'name',
  'startTime',
  'endTime',
  'duration',
  'input',
  'output',
  'children',
  'error',
  'metadata'
] as const satisfies readonly (keyof Span)[];

function spanIdentity(span: Span): string {
  return `${span.type}\u0000${span.name}`;
}

function spansAlign(left: Span, right: Span): boolean {
  return spanIdentity(left) === spanIdentity(right);
}

function matrixIndex(row: number, column: number, width: number): number {
  return row * width + column;
}

function readScore(scores: readonly number[], row: number, column: number, width: number): number {
  return scores[matrixIndex(row, column, width)] ?? 0;
}

function writeScore(scores: number[], row: number, column: number, width: number, value: number): void {
  scores[matrixIndex(row, column, width)] = value;
}

function lcsAlignSpans(baseline: readonly Span[], current: readonly Span[]): readonly Alignment[] {
  const width = current.length + 1;
  const scores = Array.from({ length: (baseline.length + 1) * width }, () => 0);

  for (let baselineIndex = 1; baselineIndex <= baseline.length; baselineIndex += 1) {
    for (let currentIndex = 1; currentIndex <= current.length; currentIndex += 1) {
      const baselineSpan = baseline[baselineIndex - 1];
      const currentSpan = current[currentIndex - 1];
      if (baselineSpan !== undefined && currentSpan !== undefined && spansAlign(baselineSpan, currentSpan)) {
        writeScore(
          scores,
          baselineIndex,
          currentIndex,
          width,
          readScore(scores, baselineIndex - 1, currentIndex - 1, width) + 1
        );
      } else {
        writeScore(
          scores,
          baselineIndex,
          currentIndex,
          width,
          Math.max(
            readScore(scores, baselineIndex - 1, currentIndex, width),
            readScore(scores, baselineIndex, currentIndex - 1, width)
          )
        );
      }
    }
  }

  const reversed: Alignment[] = [];
  let baselineIndex = baseline.length;
  let currentIndex = current.length;

  while (baselineIndex > 0 || currentIndex > 0) {
    const baselineSpan = baseline[baselineIndex - 1];
    const currentSpan = current[currentIndex - 1];

    if (
      baselineIndex > 0 &&
      currentIndex > 0 &&
      baselineSpan !== undefined &&
      currentSpan !== undefined &&
      spansAlign(baselineSpan, currentSpan)
    ) {
      reversed.push({
        kind: 'matched',
        baselineIndex: baselineIndex - 1,
        currentIndex: currentIndex - 1,
        baseline: baselineSpan,
        current: currentSpan
      });
      baselineIndex -= 1;
      currentIndex -= 1;
    } else if (
      baselineIndex > 0 &&
      (currentIndex === 0 ||
        readScore(scores, baselineIndex - 1, currentIndex, width) >=
          readScore(scores, baselineIndex, currentIndex - 1, width))
    ) {
      if (baselineSpan !== undefined) {
        reversed.push({
          kind: 'removed',
          baselineIndex: baselineIndex - 1,
          baseline: baselineSpan
        });
      }
      baselineIndex -= 1;
    } else {
      if (currentSpan !== undefined) {
        reversed.push({
          kind: 'added',
          currentIndex: currentIndex - 1,
          current: currentSpan
        });
      }
      currentIndex -= 1;
    }
  }

  return reversed.reverse();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => deepEqual(item, right[index]));
  }

  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function fullPath(spanPath: string, field: string): string {
  return field === '$' ? spanPath : `${spanPath}.${field}`;
}

function pathCandidates(spanPath: string, field: string): readonly string[] {
  return [fullPath(spanPath, field), field];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardPathMatches(path: string, rule: string): boolean {
  const escaped = escapeRegExp(rule).replaceAll('\\*', '[^.\\]]+');
  const matcher = new RegExp(`^${escaped}(?:\\..*|\\[.*)?$`);
  return matcher.test(path);
}

function pathMatches(path: string, rule: string): boolean {
  const trimmedRule = rule.trim();
  if (trimmedRule.length === 0) {
    return false;
  }

  if (trimmedRule.includes('*')) {
    return wildcardPathMatches(path, trimmedRule);
  }

  return (
    path === trimmedRule ||
    path.startsWith(`${trimmedRule}.`) ||
    path.startsWith(`${trimmedRule}[`)
  );
}

function matchesAnyPath(rules: readonly string[] | undefined, spanPath: string, field: string): boolean {
  if (rules === undefined || rules.length === 0) {
    return false;
  }

  const candidates = pathCandidates(spanPath, field);
  return rules.some((rule) => candidates.some((candidate) => pathMatches(candidate, rule)));
}

function isIgnored(options: DiffOptions, spanPath: string, field: string): boolean {
  return matchesAnyPath(options.ignorePaths, spanPath, field);
}

function isBreakingPath(options: DiffOptions, spanPath: string, field: string): boolean {
  return matchesAnyPath(options.breakingOn, spanPath, field);
}

function findComparator(
  comparators: Readonly<Record<string, DiffComparator>> | undefined,
  spanPath: string,
  field: string
): ComparatorMatch | undefined {
  if (comparators === undefined) {
    return undefined;
  }

  const candidates = pathCandidates(spanPath, field);
  for (const [rule, comparator] of Object.entries(comparators)) {
    if (candidates.some((candidate) => pathMatches(candidate, rule))) {
      return { rule, comparator };
    }
  }

  return undefined;
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function changedSeverity(options: DiffOptions, spanPath: string, field: string): DiffChangeSeverity {
  return isBreakingPath(options, spanPath, field) ? 'breaking' : 'drift';
}

function addedSeverity(options: DiffOptions, spanPath: string): DiffChangeSeverity {
  if (isBreakingPath(options, spanPath, '$')) {
    return 'breaking';
  }

  return options.allowNewSpans === true ? 'drift' : 'breaking';
}

function removedSeverity(options: DiffOptions, spanPath: string): DiffChangeSeverity {
  if (isBreakingPath(options, spanPath, '$')) {
    return 'breaking';
  }

  return options.allowRemovedSpans === true ? 'drift' : 'breaking';
}

function addChangedField(
  state: CompareState,
  spanPath: string,
  field: string,
  baseline: unknown,
  current: unknown
): void {
  state.changes.push({
    type: 'changed',
    spanPath,
    field,
    baseline,
    current,
    severity: changedSeverity(state.options, spanPath, field)
  });
}

function compareWithComparator(
  state: CompareState,
  match: ComparatorMatch,
  spanPath: string,
  field: string,
  baseline: unknown,
  current: unknown,
  baselineSpan: Span,
  currentSpan: Span
): boolean {
  const path = fullPath(spanPath, field);

  try {
    if (
      match.comparator(baseline, current, {
        path,
        spanPath,
        field,
        baselineSpan,
        currentSpan
      })
    ) {
      return true;
    }
  } catch (error) {
    state.warnings.push({
      path,
      spanPath,
      field,
      comparatorPath: match.rule,
      message: `Comparator "${match.rule}" failed at ${path}: ${messageFromUnknown(error)}`
    });
  }

  addChangedField(state, spanPath, field, baseline, current);
  return true;
}

function compareArrays(
  state: CompareState,
  spanPath: string,
  field: string,
  baseline: readonly unknown[],
  current: readonly unknown[],
  baselineSpan: Span,
  currentSpan: Span
): void {
  const maxLength = Math.max(baseline.length, current.length);

  for (let index = 0; index < maxLength; index += 1) {
    compareValue(
      state,
      spanPath,
      `${field}[${index}]`,
      baseline[index],
      current[index],
      baselineSpan,
      currentSpan
    );
  }
}

function compareRecords(
  state: CompareState,
  spanPath: string,
  field: string,
  baseline: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  baselineSpan: Span,
  currentSpan: Span
): void {
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();

  for (const key of keys) {
    const childField = field === '$' ? key : `${field}.${key}`;
    compareValue(state, spanPath, childField, baseline[key], current[key], baselineSpan, currentSpan);
  }
}

function compareValue(
  state: CompareState,
  spanPath: string,
  field: string,
  baseline: unknown,
  current: unknown,
  baselineSpan: Span,
  currentSpan: Span
): void {
  if (isIgnored(state.options, spanPath, field) || deepEqual(baseline, current)) {
    return;
  }

  const comparatorMatch = findComparator(state.options.comparators, spanPath, field);
  if (
    comparatorMatch !== undefined &&
    compareWithComparator(state, comparatorMatch, spanPath, field, baseline, current, baselineSpan, currentSpan)
  ) {
    return;
  }

  if (Array.isArray(baseline) && Array.isArray(current)) {
    compareArrays(state, spanPath, field, baseline, current, baselineSpan, currentSpan);
    return;
  }

  if (isRecord(baseline) && isRecord(current)) {
    compareRecords(state, spanPath, field, baseline, current, baselineSpan, currentSpan);
    return;
  }

  addChangedField(state, spanPath, field, baseline, current);
}

function compareAlignedSpans(
  state: CompareState,
  baselineSpan: Span,
  currentSpan: Span,
  spanPath: string
): void {
  for (const field of COMPARED_SPAN_FIELDS) {
    compareValue(
      state,
      spanPath,
      field,
      baselineSpan[field],
      currentSpan[field],
      baselineSpan,
      currentSpan
    );
  }
}

function addSpanAddition(state: CompareState, spanPath: string, span: Span): void {
  if (isIgnored(state.options, spanPath, '$')) {
    return;
  }

  state.changes.push({
    type: 'added',
    spanPath,
    field: '$',
    current: span,
    severity: addedSeverity(state.options, spanPath)
  });
}

function addSpanRemoval(state: CompareState, spanPath: string, span: Span): void {
  if (isIgnored(state.options, spanPath, '$')) {
    return;
  }

  state.changes.push({
    type: 'removed',
    spanPath,
    field: '$',
    baseline: span,
    severity: removedSeverity(state.options, spanPath)
  });
}

function createStats(aligned: number, changes: readonly DiffChange[]): DiffStats {
  const added = changes.filter((change) => change.type === 'added').length;
  const removed = changes.filter((change) => change.type === 'removed').length;
  const changed = changes.filter((change) => change.type === 'changed').length;
  const drift = changes.filter((change) => change.severity === 'drift').length;
  const breaking = changes.filter((change) => change.severity === 'breaking').length;

  return {
    aligned,
    added,
    removed,
    changed,
    drift,
    breaking,
    total: changes.length
  };
}

function statusFromStats(stats: DiffStats): DiffStatus {
  if (stats.total === 0) {
    return 'identical';
  }

  return stats.breaking > 0 ? 'breaking' : 'drift';
}

function summarize(status: DiffStatus, stats: DiffStats): string {
  if (status === 'identical') {
    return `No differences found across ${stats.aligned} aligned span${stats.aligned === 1 ? '' : 's'}.`;
  }

  return [
    `Diff contains ${stats.total} change${stats.total === 1 ? '' : 's'}`,
    `(${stats.breaking} breaking, ${stats.drift} drift):`,
    `${stats.added} added, ${stats.removed} removed, ${stats.changed} changed across ${stats.aligned} aligned spans.`
  ].join(' ');
}

/** Compares two traces using LCS span alignment and configurable contract diff rules. */
export function diff(baseline: Trace, current: Trace, options: DiffOptions = {}): DiffResult {
  const changes: DiffChange[] = [];
  const warnings: DiffWarning[] = [];
  const state: CompareState = {
    options,
    changes,
    warnings
  };
  let aligned = 0;

  for (const alignment of lcsAlignSpans(baseline.spans, current.spans)) {
    switch (alignment.kind) {
      case 'matched': {
        aligned += 1;
        compareAlignedSpans(
          state,
          alignment.baseline,
          alignment.current,
          `$.spans[${alignment.baselineIndex}]`
        );
        break;
      }
      case 'added':
        addSpanAddition(state, `$.spans[${alignment.currentIndex}]`, alignment.current);
        break;
      case 'removed':
        addSpanRemoval(state, `$.spans[${alignment.baselineIndex}]`, alignment.baseline);
        break;
    }
  }

  const stats = createStats(aligned, changes);
  const status = statusFromStats(stats);

  return {
    status,
    summary: summarize(status, stats),
    changes,
    warnings,
    stats
  };
}
