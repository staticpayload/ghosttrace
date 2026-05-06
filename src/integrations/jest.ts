import type { RecordOptions, ReplayOptions } from '../core/types.js';
import { createFrameworkRecordReplayContext } from './shared.js';

/** Options accepted by the Jest integration entry point. */
export interface GhostJestOptions {
  /** Directory containing trace baselines. */
  readonly traceDir?: string;
  /** Interceptors to enable while recording. */
  readonly interceptors?: RecordOptions['interceptors'];
  /** Plugins applied during wrapper recording and replay lifecycle operations. */
  readonly plugins?: RecordOptions['plugins'];
  /** Replay options used when an existing baseline is replayed. */
  readonly replay?: ReplayOptions;
}

/** Wraps a Jest test function while preserving its call signature. */
export function withGhostTrace<TArgs extends readonly unknown[], TOutput>(
  testName: string,
  fn: (...args: TArgs) => TOutput | Promise<TOutput>,
  options: GhostJestOptions = {}
): (...args: TArgs) => Promise<Awaited<TOutput>> {
  const lifecycle = createFrameworkRecordReplayContext({
    framework: 'jest',
    fallbackTraceName: 'ghosttrace-jest-test',
    testName,
    traceOptions: options
  });

  return async (...args: TArgs): Promise<Awaited<TOutput>> =>
    lifecycle.record(async () => fn(...args), options.replay ?? {});
}
