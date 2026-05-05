import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
    'integrations/vitest': 'src/integrations/vitest.ts',
    'integrations/jest': 'src/integrations/jest.ts',
    'integrations/playwright': 'src/integrations/playwright.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  treeshake: true,
  target: 'node18',
  platform: 'node',
  external: ['vitest', 'jest', '@playwright/test'],
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  }
});
