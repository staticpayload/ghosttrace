import type { RecordOptions } from '../core/types.js';

/** Options accepted by the Jest integration entry point. */
export interface GhostJestOptions {
  /** Directory containing trace baselines. */
  readonly traceDir?: string;
  /** Interceptors to enable while recording. */
  readonly interceptors?: RecordOptions['interceptors'];
}

/** Wraps a Jest test function while preserving its call signature. */
export function withGhostTrace<TArgs extends readonly unknown[], TOutput>(
  testName: string,
  fn: (...args: TArgs) => TOutput | Promise<TOutput>,
  options: GhostJestOptions = {}
): (...args: TArgs) => Promise<Awaited<TOutput>> {
  void testName;
  void options;

  return async (...args: TArgs): Promise<Awaited<TOutput>> => fn(...args) as Awaited<TOutput>;
}
