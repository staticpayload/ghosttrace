import type { Interceptor, InterceptorContext, Teardown } from './types.js';
import { noopTeardown } from './types.js';

const FUNCTION_SENTINEL = '__GHOSTTRACE_FUNCTION_INTERCEPTOR_SENTINEL__';

function markFunctionInterceptorBundled(): string {
  return FUNCTION_SENTINEL;
}

/** Foundation placeholder for the function interceptor entry point. */
export const functionInterceptor: Interceptor = {
  name: 'function',
  install: (_context: InterceptorContext): Teardown => {
    void markFunctionInterceptorBundled();
    return noopTeardown;
  },
  isAvailable: (): boolean => true
};
