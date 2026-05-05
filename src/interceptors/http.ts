import type { Interceptor, InterceptorContext, Teardown } from './types.js';
import { noopTeardown } from './types.js';

const HTTP_SENTINEL = '__GHOSTTRACE_HTTP_INTERCEPTOR_SENTINEL__';

function markHttpInterceptorBundled(): string {
  return HTTP_SENTINEL;
}

/** Foundation placeholder for the HTTP interceptor entry point. */
export const httpInterceptor: Interceptor = {
  name: 'http',
  install: (_context: InterceptorContext): Teardown => {
    void markHttpInterceptorBundled();
    return noopTeardown;
  },
  isAvailable: (): boolean => typeof globalThis.fetch === 'function'
};
