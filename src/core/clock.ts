/** Options for creating a deterministic relative virtual clock. */
export interface VirtualClockOptions {
  /** First timestamp returned by the clock. Defaults to 0 for trace-relative time. */
  readonly startTime?: number;
  /** Positive increment applied after each read. Defaults to 1 millisecond. */
  readonly step?: number;
}

/** Monotonic deterministic clock used to assign trace-relative timestamps. */
export interface VirtualClock {
  /** First timestamp in the deterministic sequence. */
  readonly startTime: number;
  /** Positive increment between generated timestamps. */
  readonly step: number;
  /** Returns the current timestamp and advances the deterministic sequence. */
  readonly now: () => number;
  /** Returns the next timestamp without advancing the deterministic sequence. */
  readonly peek: () => number;
  /** Resets the deterministic sequence back to startTime. */
  readonly reset: () => void;
}

const DEFAULT_START_TIME = 0;
const DEFAULT_STEP = 1;

function normalizeFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }

  return value;
}

function normalizePositiveStep(value: number): number {
  const step = normalizeFiniteNumber(value, 'VirtualClock step');

  if (step <= 0) {
    throw new RangeError('VirtualClock step must be greater than 0');
  }

  return step;
}

/** Creates a deterministic virtual clock whose first relative timestamp is 0 by default. */
export function createVirtualClock(options: VirtualClockOptions = {}): VirtualClock {
  const startTime = normalizeFiniteNumber(options.startTime ?? DEFAULT_START_TIME, 'VirtualClock startTime');
  const step = normalizePositiveStep(options.step ?? DEFAULT_STEP);
  let currentTime = startTime;

  return {
    startTime,
    step,
    now: () => {
      const timestamp = currentTime;
      currentTime += step;
      return timestamp;
    },
    peek: () => currentTime,
    reset: () => {
      currentTime = startTime;
    }
  };
}
