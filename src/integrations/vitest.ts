import type { RecordOptions, ReplayOptions, Span } from '../core/types.js';

/** Options accepted by the Vitest integration entry point. */
export interface GhostVitestOptions {
  /** Directory containing trace baselines. */
  readonly traceDir?: string;
  /** Interceptors to enable while recording. */
  readonly interceptors?: RecordOptions['interceptors'];
}

/** Ghost fixture surface provided to Vitest tests by future integration work. */
export interface GhostVitestContext {
  /** Trace file path associated with the current test. */
  readonly traceFile: string;
  /** Spans collected or replayed for the current test. */
  readonly spans: readonly Span[];
  /** Records the current test flow. */
  readonly record: <TOutput>(fn: () => TOutput | Promise<TOutput>) => Promise<TOutput>;
  /** Replays the current test flow. */
  readonly replay: <TOutput>(fn: () => TOutput | Promise<TOutput>, options?: ReplayOptions) => Promise<TOutput>;
  /** Updates the stored baseline trace. */
  readonly update: () => Promise<void>;
}

/** Placeholder Vitest fixture factory exported for sub-path resolution. */
export function ghostFixture(options: GhostVitestOptions = {}): GhostVitestOptions {
  return { ...options };
}
