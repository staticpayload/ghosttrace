import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build as bundleWithEsbuild } from 'esbuild';
import { describe, expect, it, beforeAll } from 'vitest';

const projectRoot = resolve(__dirname, '../..');
const distDir = join(projectRoot, 'dist');
const packageJsonPath = join(projectRoot, 'package.json');
const requireFromTest = createRequire(import.meta.url);

interface PackageExportConditions {
  readonly types: string;
  readonly import: string;
  readonly require: string;
}

interface GhostTracePackageJson {
  readonly version: string;
  readonly bin: {
    readonly ghost: string;
  };
  readonly exports: {
    readonly '.': PackageExportConditions;
    readonly './vitest': PackageExportConditions;
    readonly './jest': PackageExportConditions;
    readonly './playwright': PackageExportConditions;
  };
}

function readPackageJson(): GhostTracePackageJson {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as GhostTracePackageJson;
}

function runPnpmBuild(): void {
  rmSync(distDir, { recursive: true, force: true });
  execFileSync('pnpm', ['build'], {
    cwd: projectRoot,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: 'pipe'
  });
}

describe('project setup', () => {
  beforeAll(() => {
    runPnpmBuild();
  });

  it('build emits non-empty CJS, ESM, and type declaration entry points', () => {
    const expectedFiles = ['index.cjs', 'index.mjs', 'index.d.ts'];

    for (const fileName of expectedFiles) {
      const filePath = join(distDir, fileName);
      expect(existsSync(filePath), `${fileName} should exist`).toBe(true);
      expect(statSync(filePath).size, `${fileName} should be non-empty`).toBeGreaterThan(0);
    }

    const declarations = readFileSync(join(distDir, 'index.d.ts'), 'utf8');
    expect(declarations).toContain('Trace');
    expect(declarations).toContain('Span');
    expect(declarations).toContain('SpanType');
    expect(declarations).toContain('export {');
  });

  it('package exports map resolves import, require, and types conditions', async () => {
    const packageJson = readPackageJson();

    expect(packageJson.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
      require: './dist/index.cjs'
    });

    const imported = await import('ghosttrace');
    const required = requireFromTest('ghosttrace') as typeof imported;

    expect(imported.SpanType.Function).toBe('function');
    expect(required.SpanType.Function).toBe('function');
    expect(typeof imported.createTrace).toBe('function');
    expect(typeof required.createTrace).toBe('function');
  });

  it('sub-path exports resolve to valid ESM and CJS integration modules', async () => {
    const packageJson = readPackageJson();

    expect(packageJson.exports['./vitest']).toEqual({
      types: './dist/integrations/vitest.d.ts',
      import: './dist/integrations/vitest.mjs',
      require: './dist/integrations/vitest.cjs'
    });
    expect(packageJson.exports['./jest']).toEqual({
      types: './dist/integrations/jest.d.ts',
      import: './dist/integrations/jest.mjs',
      require: './dist/integrations/jest.cjs'
    });
    expect(packageJson.exports['./playwright']).toEqual({
      types: './dist/integrations/playwright.d.ts',
      import: './dist/integrations/playwright.mjs',
      require: './dist/integrations/playwright.cjs'
    });

    const vitestIntegration = await import('ghosttrace/vitest');
    const jestIntegration = await import('ghosttrace/jest');
    const playwrightIntegration = await import('ghosttrace/playwright');

    expect(typeof vitestIntegration.ghostFixture).toBe('function');
    expect(typeof jestIntegration.withGhostTrace).toBe('function');
    expect(typeof playwrightIntegration.createGhostPlaywright).toBe('function');
    expect(typeof requireFromTest('ghosttrace/vitest').ghostFixture).toBe('function');
    expect(typeof requireFromTest('ghosttrace/jest').withGhostTrace).toBe('function');
    expect(typeof requireFromTest('ghosttrace/playwright').createGhostPlaywright).toBe('function');
  });

  it('CLI binary has a shebang, executable bit, and prints the package version', () => {
    const packageJson = readPackageJson();
    const cliPath = join(projectRoot, packageJson.bin.ghost);
    const cliSource = readFileSync(cliPath, 'utf8');

    expect(cliSource.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(statSync(cliPath).mode & 0o111).toBeGreaterThan(0);

    const output = execFileSync('node', [cliPath, '--version'], {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim();
    expect(output).toBe(packageJson.version);
  });

  it('consumer bundling tree-shakes unused interceptors from the bundle', async () => {
    const result = await bundleWithEsbuild({
      stdin: {
        contents: [
          "import { SpanType, createTrace } from 'ghosttrace';",
          "const trace = createTrace({ id: 'trace_1', name: 'tree-shake', spans: [] });",
          "console.log(SpanType.Function, trace.id);"
        ].join('\n'),
        resolveDir: projectRoot,
        sourcefile: 'consumer.mjs'
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      treeShaking: true,
      absWorkingDir: projectRoot,
      packages: 'bundle'
    });

    const bundle = result.outputFiles[0]?.text ?? '';
    expect(bundle).toContain('tree-shake');
    expect(bundle).not.toContain('__GHOSTTRACE_HTTP_INTERCEPTOR_SENTINEL__');
    expect(bundle).not.toContain('__GHOSTTRACE_FS_INTERCEPTOR_SENTINEL__');
  });
});
