import { promises as fsPromises } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportError, ghost } from '../../src/index.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghosttrace-save-'));
  tempDirs.push(directory);
  return directory;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
}

describe('trace persistence', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('trace.save() creates directories and writes valid deterministic JSON', async () => {
    const directory = await createTempDir();
    const targetPath = join(directory, 'nested', 'deterministic.ghosttrace.json');
    const trace = await ghost.record('save-flow', async () => ({ ok: true, count: 2 }), {
      interceptors: []
    });

    const savedPath = await trace.save(targetPath);
    const firstSave = await readFile(targetPath, 'utf8');
    const parsed = await readJsonFile(targetPath);

    expect(savedPath).toBe(targetPath);
    expect(parsed.name).toBe('save-flow');
    expect(parsed.metadata).toEqual({ name: 'save-flow' });
    expect(parsed.spans).toEqual(trace.spans);
    expect(parsed).not.toHaveProperty('save');

    await trace.save(targetPath);
    await trace.save(join(directory, 'nested', 'deterministic-copy.ghosttrace.json'));

    expect(await readFile(targetPath, 'utf8')).toBe(firstSave);
    expect(await readFile(join(directory, 'nested', 'deterministic-copy.ghosttrace.json'), 'utf8')).toBe(firstSave);
  });

  it('trace.save() throws ExportError when fs.writeFile fails', async () => {
    const directory = await createTempDir();
    const trace = await ghost.record('write-failure', () => 'ok', {
      interceptors: []
    });
    const writeError = new Error('disk full');
    const writeFileSpy = vi.spyOn(fsPromises, 'writeFile').mockRejectedValueOnce(writeError);

    await expect(trace.save(join(directory, 'failure.ghosttrace.json'))).rejects.toBeInstanceOf(ExportError);
    await expect(trace.save(join(directory, 'failure-again.ghosttrace.json'))).resolves.toBe(
      join(directory, 'failure-again.ghosttrace.json')
    );
    expect(writeFileSpy).toHaveBeenCalledTimes(2);
  });

  it('uses a sanitized record name for default directory-based file naming', async () => {
    const directory = await createTempDir();
    const trace = await ghost.record('User Login: primary/admin?', () => 'ok', {
      interceptors: []
    });

    const savedPath = await trace.save({ directory });
    const parsed = await readJsonFile(savedPath);

    expect(basename(savedPath)).toMatch(/^user-login-primary-admin\.\d+\.ghosttrace\.json$/u);
    expect(parsed.name).toBe('User Login: primary/admin?');
    expect(parsed.metadata).toEqual({ name: 'User Login: primary/admin?' });
  });
});
