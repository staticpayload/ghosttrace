import type { RecordOptions } from '../core/types.js';

/** Options accepted by the Playwright integration entry point. */
export interface GhostPlaywrightOptions {
  /** Directory containing trace baselines. */
  readonly traceDir?: string;
  /** Interceptors to enable while recording. */
  readonly interceptors?: RecordOptions['interceptors'];
}

/** Minimal Playwright integration surface exported for sub-path resolution. */
export interface GhostPlaywrightController {
  /** Captured integration options. */
  readonly options: GhostPlaywrightOptions;
  /** Attaches GhostTrace network interception to a Playwright page in future features. */
  readonly interceptPage: (page: unknown) => Promise<void>;
}

/** Creates a placeholder Playwright controller for future integration behavior. */
export function createGhostPlaywright(options: GhostPlaywrightOptions = {}): GhostPlaywrightController {
  return {
    options: { ...options },
    interceptPage: async (_page: unknown): Promise<void> => undefined
  };
}
