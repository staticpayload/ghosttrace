import type { Interceptor, InterceptorContext, Teardown } from './types.js';
import { noopTeardown } from './types.js';

const FS_SENTINEL = '__GHOSTTRACE_FS_INTERCEPTOR_SENTINEL__';

function markFsInterceptorBundled(): string {
  return FS_SENTINEL;
}

/** Foundation placeholder for the filesystem interceptor entry point. */
export const fsInterceptor: Interceptor = {
  name: 'fs',
  install: (_context: InterceptorContext): Teardown => {
    void markFsInterceptorBundled();
    return noopTeardown;
  },
  isAvailable: (): boolean => typeof process !== 'undefined' && process.versions.node !== undefined
};
