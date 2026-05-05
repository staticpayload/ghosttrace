/** Options for a deterministic sequential ID generator. */
export interface IdGeneratorOptions {
  /** Stable ID prefix. Defaults to "span". */
  readonly prefix?: string;
  /** First numeric sequence value. Defaults to 1. */
  readonly start?: number;
  /** Minimum zero-padded width for the numeric sequence. Defaults to 4. */
  readonly width?: number;
  /** Separator between the prefix and sequence. Defaults to "_". */
  readonly separator?: string;
}

/** Counter-based deterministic ID generator scoped to one trace. */
export interface DeterministicIdGenerator {
  /** Stable ID prefix. */
  readonly prefix: string;
  /** First numeric sequence value. */
  readonly start: number;
  /** Minimum zero-padded width for the numeric sequence. */
  readonly width: number;
  /** Separator between prefix and sequence. */
  readonly separator: string;
  /** Returns the next deterministic ID and advances the sequence. */
  readonly next: () => string;
  /** Returns the next deterministic ID without advancing the sequence. */
  readonly peek: () => string;
  /** Resets the sequence to the initial start value. */
  readonly reset: () => void;
}

const DEFAULT_PREFIX = 'span';
const DEFAULT_START = 1;
const DEFAULT_WIDTH = 4;
const DEFAULT_SEPARATOR = '_';

function normalizePrefix(prefix: string): string {
  if (prefix.length === 0) {
    throw new RangeError('ID prefix must not be empty');
  }

  return prefix;
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }

  return value;
}

function formatId(prefix: string, separator: string, sequence: number, width: number): string {
  return `${prefix}${separator}${String(sequence).padStart(width, '0')}`;
}

/** Creates a deterministic sequential ID generator reset for each trace context. */
export function createIdGenerator(options: IdGeneratorOptions = {}): DeterministicIdGenerator {
  const prefix = normalizePrefix(options.prefix ?? DEFAULT_PREFIX);
  const start = normalizeNonNegativeInteger(options.start ?? DEFAULT_START, 'ID start');
  const width = normalizeNonNegativeInteger(options.width ?? DEFAULT_WIDTH, 'ID width');
  const separator = options.separator ?? DEFAULT_SEPARATOR;
  let nextSequence = start;

  return {
    prefix,
    start,
    width,
    separator,
    next: () => {
      const id = formatId(prefix, separator, nextSequence, width);
      nextSequence += 1;
      return id;
    },
    peek: () => formatId(prefix, separator, nextSequence, width),
    reset: () => {
      nextSequence = start;
    }
  };
}
