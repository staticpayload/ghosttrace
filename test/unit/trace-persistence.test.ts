import { promises as fsPromises } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportError, ghost } from '../../src/index.js';

const tempDirs: string[] = [];
const ISO_TIMESTAMP_PATTERN_SOURCE = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
const ISO_TIMESTAMP_PATTERN = new RegExp(`^${ISO_TIMESTAMP_PATTERN_SOURCE}$`, 'u');
const SANITIZED_TIMESTAMP_PATTERN_SOURCE = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
const UNSAFE_FILENAME_CHARACTER = /[<>:"/\\|?*\u0000-\u001F]/u;
const SECRET_TRACE_NAME_VALUE = 'sk-1234567890abcdef1234567890abcdef';

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
    expect(parsed.metadata).toEqual(
      expect.objectContaining({
        name: 'save-flow',
        recordedAt: expect.stringMatching(ISO_TIMESTAMP_PATTERN)
      })
    );
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

    expect(basename(savedPath)).toMatch(
      new RegExp(`^user-login-primary-admin\\.${SANITIZED_TIMESTAMP_PATTERN_SOURCE}\\.ghosttrace\\.json$`, 'u')
    );
    expect(basename(savedPath)).not.toMatch(UNSAFE_FILENAME_CHARACTER);
    expect(parsed.name).toBe('User Login: primary/admin?');
    expect(parsed.metadata).toEqual(
      expect.objectContaining({
        name: 'User Login: primary/admin?',
        recordedAt: expect.stringMatching(ISO_TIMESTAMP_PATTERN)
      })
    );
  });

  it('derives default filenames from the redacted trace name', async () => {
    const directory = await createTempDir();
    const trace = await ghost.record(`Checkout ${SECRET_TRACE_NAME_VALUE}`, () => 'ok', {
      interceptors: []
    });

    const savedPath = await trace.save({ directory });
    const parsed = await readJsonFile(savedPath);

    expect(basename(savedPath)).toMatch(
      new RegExp(`^checkout-redacted-api_key\\.${SANITIZED_TIMESTAMP_PATTERN_SOURCE}\\.ghosttrace\\.json$`, 'u')
    );
    expect(basename(savedPath)).not.toContain(SECRET_TRACE_NAME_VALUE.toLowerCase());
    expect(JSON.stringify(parsed)).not.toContain(SECRET_TRACE_NAME_VALUE);
  });

  it('uses wall-clock ISO timestamps for default filenames without same-name collisions', async () => {
    const directory = await createTempDir();
    const fixedWallClockTime = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedWallClockTime);

    const firstTrace = await ghost.record('Collision Flow', () => 'first', {
      interceptors: []
    });
    const secondTrace = await ghost.record('Collision Flow', () => 'second', {
      interceptors: []
    });

    const firstPath = await firstTrace.save({ directory });
    const secondPath = await secondTrace.save({ directory });

    expect(dateNowSpy).toHaveBeenCalled();
    expect(firstPath).not.toBe(secondPath);
    const firstFileName = basename(firstPath);
    const secondFileName = basename(secondPath);
    const filenamePattern = new RegExp(
      `^collision-flow\\.(${SANITIZED_TIMESTAMP_PATTERN_SOURCE})\\.ghosttrace\\.json$`,
      'u'
    );
    const firstMatch = firstFileName.match(filenamePattern);
    const secondMatch = secondFileName.match(filenamePattern);

    expect(firstMatch).not.toBeNull();
    expect(secondMatch).not.toBeNull();
    expect(firstMatch?.[1]).not.toMatch(/[:.]/u);
    expect(secondMatch?.[1]).not.toMatch(/[:.]/u);
    expect(firstFileName).not.toMatch(UNSAFE_FILENAME_CHARACTER);
    expect(secondFileName).not.toMatch(UNSAFE_FILENAME_CHARACTER);
    expect(firstFileName).not.toBe(secondFileName);
    expect(firstTrace.metadata.recordedAt).toEqual(expect.stringMatching(ISO_TIMESTAMP_PATTERN));
    expect(secondTrace.metadata.recordedAt).toEqual(expect.stringMatching(ISO_TIMESTAMP_PATTERN));
  });
});
