import { mkdtempSync, rmSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import * as nodeHttp from 'node:http';
import * as nodeHttps from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeVitestTask {
  readonly name: string;
  readonly fullName?: string;
  readonly fullTestName?: string;
}

interface FakeGhostContext {
  readonly traceFile: string;
}

type FakeGhostFixture = (
  args: { readonly task: FakeVitestTask },
  use: (context: FakeGhostContext) => Promise<void>
) => Promise<void>;

interface FakeTestApi {
  (name?: unknown, fn?: unknown): void;
  extend: (fixtures: { readonly ghost: FakeGhostFixture }) => FakeTestApi;
}

interface FakeRequire {
  (specifier: string): unknown;
  resolve: (specifier: string) => string;
}

function createFakeTestApi(onExtend: (fixture: FakeGhostFixture) => void): FakeTestApi {
  const testApi = (() => undefined) as FakeTestApi;
  testApi.extend = (fixtures) => {
    onExtend(fixtures.ghost);
    return testApi;
  };

  return testApi;
}

describe('Vitest integration task identity', () => {
  afterEach(() => {
    vi.doUnmock('node:module');
    vi.resetModules();
  });

  it('prefers the file-qualified task identity when Vitest also exposes a duplicate-prone fullTestName', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'ghosttrace-vitest-task-identity-'));
    let capturedFixture: FakeGhostFixture | undefined;
    const fakeTestApi = createFakeTestApi((fixture) => {
      capturedFixture = fixture;
    });
    const fakeRequire = ((specifier: string): unknown => {
      if (specifier === 'node:http') {
        return nodeHttp;
      }
      if (specifier === 'node:https') {
        return nodeHttps;
      }
      if (specifier === 'node:fs') {
        return nodeFs;
      }
      if (specifier === 'node:fs/promises') {
        return nodeFsPromises;
      }

      expect(specifier).toContain('vitest/dist/index.js');
      return { test: fakeTestApi };
    }) as FakeRequire;
    fakeRequire.resolve = (specifier: string): string => {
      expect(specifier).toBe('vitest/package.json');
      return '/virtual/vitest/package.json';
    };

    vi.doMock('node:module', () => ({
      createRequire: () => fakeRequire,
      syncBuiltinESMExports
    }));

    try {
      const integration = await import('../../src/integrations/vitest.js');
      const ghostFixture = (integration as {
        readonly ghostFixture: (options: { readonly traceDir: string }) => unknown;
      }).ghostFixture;
      ghostFixture({ traceDir });

      let traceFile = '';
      await capturedFixture?.(
        {
          task: {
            name: 'duplicate test',
            fullTestName: 'shared suite duplicate test',
            fullName: 'test/a.spec.ts > shared suite > duplicate test'
          }
        },
        async (ghost) => {
          traceFile = ghost.traceFile;
        }
      );

      expect(basename(traceFile)).toContain('test-a.spec.ts');
      expect(basename(traceFile)).not.toBe('shared-suite-duplicate-test.ghosttrace.json');
    } finally {
      rmSync(traceDir, { recursive: true, force: true });
    }
  });
});
