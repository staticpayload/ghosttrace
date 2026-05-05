import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile as seedWriteFile } from 'node:fs/promises';
import {
  access as accessPromise,
  mkdir as mkdirPromise,
  readFile as readFilePromise,
  readdir as readdirPromise,
  rename as renamePromise,
  stat as statPromise,
  unlink as unlinkPromise,
  writeFile as writeFilePromise
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SpanType, ghost, type Span } from '../../src/index.js';

const tempRoots: string[] = [];
const largeFileThresholdBytes = 256 * 1024;
const freshProcessReplayTimeoutMs = 20_000;
const execFile = promisify(execFileCallback);

function fsSpans(spans: readonly Span[]): readonly Span[] {
  return spans.filter((span) => span.type === SpanType.Fs);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outputResult(span: Span | undefined): unknown {
  return isRecord(span?.output) ? span.output.result : undefined;
}

async function tempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghosttrace-fs-'));
  tempRoots.push(directory);
  return directory;
}

function readFileCallback(path: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.readFile(path, encoding, (error, data) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(data);
    });
  });
}

function writeFileCallback(path: string, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.writeFile(path, data, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function readdirCallback(path: string): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    fs.readdir(path, (error, entries) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(entries);
    });
  });
}

function statCallback(path: string): Promise<fs.Stats> {
  return new Promise((resolve, reject) => {
    fs.stat(path, (error, stats) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(stats);
    });
  });
}

function accessCallback(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.access(path, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function mkdirCallback(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdir(path, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function renameCallback(oldPath: string, newPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.rename(oldPath, newPath, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function unlinkCallback(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.unlink(path, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe('filesystem interceptor', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('records every configured FS operation across callback, sync, and promises APIs', async () => {
    const root = await tempRoot();
    const callbackSource = join(root, 'callback-source.txt');
    const syncSource = join(root, 'sync-source.txt');
    const promiseSource = join(root, 'promise-source.txt');
    await Promise.all([
      seedWriteFile(callbackSource, 'callback-source', 'utf8'),
      seedWriteFile(syncSource, 'sync-source', 'utf8'),
      seedWriteFile(promiseSource, 'promise-source', 'utf8')
    ]);

    const trace = await ghost.record(
      'fs-all-operations',
      async () => {
        const callbackWrite = join(root, 'callback-write.txt');
        const callbackRenamed = join(root, 'callback-renamed.txt');
        await readFileCallback(callbackSource);
        await writeFileCallback(callbackWrite, 'callback-write');
        await readdirCallback(root);
        expect((await statCallback(callbackSource)).isFile()).toBe(true);
        await accessCallback(callbackSource);
        await mkdirCallback(join(root, 'callback-dir'));
        await renameCallback(callbackWrite, callbackRenamed);
        await unlinkCallback(callbackRenamed);

        const syncWrite = join(root, 'sync-write.txt');
        const syncRenamed = join(root, 'sync-renamed.txt');
        fs.readFileSync(syncSource, 'utf8');
        fs.writeFileSync(syncWrite, 'sync-write', 'utf8');
        fs.readdirSync(root);
        expect(fs.statSync(syncSource).isFile()).toBe(true);
        fs.accessSync(syncSource);
        fs.mkdirSync(join(root, 'sync-dir'));
        fs.renameSync(syncWrite, syncRenamed);
        fs.unlinkSync(syncRenamed);

        const promiseWrite = join(root, 'promise-write.txt');
        const promiseRenamed = join(root, 'promise-renamed.txt');
        await readFilePromise(promiseSource, 'utf8');
        await writeFilePromise(promiseWrite, 'promise-write', 'utf8');
        await readdirPromise(root);
        expect((await statPromise(promiseSource)).isFile()).toBe(true);
        await accessPromise(promiseSource);
        await mkdirPromise(join(root, 'promise-dir'));
        await renamePromise(promiseWrite, promiseRenamed);
        await unlinkPromise(promiseRenamed);
      },
      { interceptors: ['fs'] }
    );

    const spans = fsSpans(trace.spans);
    expect(spans.map((span) => span.name)).toEqual([
      'fs.readFile',
      'fs.writeFile',
      'fs.readdir',
      'fs.stat',
      'fs.access',
      'fs.mkdir',
      'fs.rename',
      'fs.unlink',
      'fs.readFileSync',
      'fs.writeFileSync',
      'fs.readdirSync',
      'fs.statSync',
      'fs.accessSync',
      'fs.mkdirSync',
      'fs.renameSync',
      'fs.unlinkSync',
      'fs.promises.readFile',
      'fs.promises.writeFile',
      'fs.promises.readdir',
      'fs.promises.stat',
      'fs.promises.access',
      'fs.promises.mkdir',
      'fs.promises.rename',
      'fs.promises.unlink'
    ]);
    expect(spans.map((span) => span.metadata.operation)).toEqual([
      'readFile',
      'writeFile',
      'readdir',
      'stat',
      'access',
      'mkdir',
      'rename',
      'unlink',
      'readFile',
      'writeFile',
      'readdir',
      'stat',
      'access',
      'mkdir',
      'rename',
      'unlink',
      'readFile',
      'writeFile',
      'readdir',
      'stat',
      'access',
      'mkdir',
      'rename',
      'unlink'
    ]);
    expect(spans.map((span) => span.metadata.api)).toEqual([
      'callback',
      'callback',
      'callback',
      'callback',
      'callback',
      'callback',
      'callback',
      'callback',
      'sync',
      'sync',
      'sync',
      'sync',
      'sync',
      'sync',
      'sync',
      'sync',
      'promises',
      'promises',
      'promises',
      'promises',
      'promises',
      'promises',
      'promises',
      'promises'
    ]);
    expect(spans[0]?.input).toMatchObject({ path: callbackSource, operation: 'readFile' });
    expect(outputResult(spans[0])).toMatchObject({ content: 'callback-source', byteLength: 15 });
    expect(isRecord(spans[1]?.input) ? spans[1].input.data : undefined).toMatchObject({
      content: 'callback-write',
      byteLength: 14
    });
  });

  it('records FS errors with the original error details', async () => {
    const root = await tempRoot();
    const missing = join(root, 'missing.txt');

    const trace = await ghost.record(
      'fs-errors',
      () => {
        try {
          fs.readFileSync(missing, 'utf8');
        } catch {
          return 'handled';
        }

        return 'unexpected';
      },
      { interceptors: ['fs'] }
    );

    const span = fsSpans(trace.spans)[0];
    expect(span).toMatchObject({
      name: 'fs.readFileSync',
      input: {
        operation: 'readFile',
        path: missing
      },
      error: {
        name: 'Error',
        code: 'ENOENT'
      }
    });
  });

  it('stores files larger than 256KB by SHA-256 contentRef while keeping 256KB inline', async () => {
    const root = await tempRoot();
    const inlinePath = join(root, 'inline.bin');
    const largePath = join(root, 'large.bin');
    const inlineBytes = Buffer.alloc(largeFileThresholdBytes, 0x61);
    const largeBytes = Buffer.alloc(largeFileThresholdBytes + 1, 0x62);
    await Promise.all([seedWriteFile(inlinePath, inlineBytes), seedWriteFile(largePath, largeBytes)]);

    const trace = await ghost.record(
      'fs-large-content',
      () => {
        fs.readFileSync(inlinePath);
        fs.readFileSync(largePath);
      },
      { interceptors: ['fs'] }
    );

    const [inlineSpan, largeSpan] = fsSpans(trace.spans);
    const inlineResult = outputResult(inlineSpan);
    const largeResult = outputResult(largeSpan);

    expect(inlineResult).toMatchObject({
      contentBase64: inlineBytes.toString('base64'),
      byteLength: largeFileThresholdBytes
    });
    expect(isRecord(inlineResult) ? inlineResult.contentRef : undefined).toBeUndefined();
    expect(largeResult).toMatchObject({
      contentRef: {
        algorithm: 'sha256',
        hash: createHash('sha256').update(largeBytes).digest('hex'),
        byteLength: largeFileThresholdBytes + 1
      },
      byteLength: largeFileThresholdBytes + 1
    });
    expect(isRecord(largeResult) ? largeResult.content : undefined).toBeUndefined();
    expect(isRecord(largeResult) ? largeResult.contentBase64 : undefined).toBeUndefined();
  });

  it('throws a descriptive contentRef error when large content is replayed in a fresh process', async () => {
    const root = await tempRoot();
    const largePath = join(root, 'large.bin');
    const scriptPath = join(root, 'fresh-contentref-replay.ts');
    const largeBytes = Buffer.alloc(largeFileThresholdBytes + 1, 0x63);
    await seedWriteFile(largePath, largeBytes);

    const trace = await ghost.record(
      'fs-fresh-contentref-replay',
      () => {
        fs.readFileSync(largePath);
        return 'recorded';
      },
      { interceptors: ['fs'] }
    );
    await rm(largePath);

    await seedWriteFile(
      scriptPath,
      `
        import * as fs from 'node:fs';
        import { ghost } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/index.ts')).href)};

        const traceText = process.env.GHOSTTRACE_TRACE;
        const targetPath = process.env.GHOSTTRACE_PATH;
        if (traceText === undefined || targetPath === undefined) {
          throw new Error('missing fresh replay test environment');
        }

        void (async () => {
          try {
            await ghost.replay(JSON.parse(traceText), () => fs.readFileSync(targetPath));
            console.error('expected contentRef replay to fail in a fresh process');
            process.exit(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(message);
            process.exit(message.includes('not available in the trace') ? 2 : 3);
          }
        })();
      `,
      'utf8'
    );

    await expect(
      execFile(process.execPath, ['--import', 'tsx', scriptPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          GHOSTTRACE_PATH: largePath,
          GHOSTTRACE_TRACE: JSON.stringify(trace)
        }
      })
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('not available in the trace')
    });
  }, freshProcessReplayTimeoutMs);

  it('replays recorded reads without disk access after files are deleted', async () => {
    const root = await tempRoot();
    const source = join(root, 'recorded.txt');
    await seedWriteFile(source, 'recorded-content', 'utf8');

    const trace = await ghost.record(
      'fs-replay-reads',
      async () => ({
        sync: fs.readFileSync(source, 'utf8'),
        promise: await readFilePromise(source, 'utf8'),
        callback: await readFileCallback(source),
        entries: fs.readdirSync(root),
        statIsFile: fs.statSync(source).isFile(),
        access: fs.accessSync(source) ?? 'ok'
      }),
      { interceptors: ['fs'] }
    );

    await rm(root, { recursive: true, force: true });

    const replayed = await ghost.replay(trace, async () => ({
      sync: fs.readFileSync(source, 'utf8'),
      promise: await readFilePromise(source, 'utf8'),
      callback: await readFileCallback(source),
      entries: fs.readdirSync(root),
      statIsFile: fs.statSync(source).isFile(),
      access: fs.accessSync(source) ?? 'ok'
    }));

    expect(replayed.output).toEqual({
      sync: 'recorded-content',
      promise: 'recorded-content',
      callback: 'recorded-content',
      entries: ['recorded.txt'],
      statIsFile: true,
      access: 'ok'
    });
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual([
      'fs.readFileSync',
      'fs.promises.readFile',
      'fs.readFile',
      'fs.readdirSync',
      'fs.statSync',
      'fs.accessSync'
    ]);
  });

  it('replays callback-style FS operations asynchronously', async () => {
    const root = await tempRoot();
    const source = join(root, 'recorded.txt');
    await seedWriteFile(source, 'recorded-content', 'utf8');

    const trace = await ghost.record(
      'fs-callback-async-replay',
      () => readFileCallback(source),
      { interceptors: ['fs'] }
    );
    await rm(root, { recursive: true, force: true });

    const replayed = await ghost.replay(trace, () => {
      const order: string[] = [];

      return new Promise<readonly string[]>((resolve, reject) => {
        fs.readFile(source, 'utf8', (error) => {
          order.push('callback');
          if (error !== null) {
            reject(error);
            return;
          }

          resolve([...order]);
        });
        order.push('after-registration');
      });
    });

    expect(replayed.output).toEqual(['after-registration', 'callback']);
  });

  it('makes writeFile a no-op during replay across sync, promises, and callback APIs', async () => {
    const root = await tempRoot();
    const syncPath = join(root, 'sync-output.txt');
    const promisePath = join(root, 'promise-output.txt');
    const callbackPath = join(root, 'callback-output.txt');

    const trace = await ghost.record(
      'fs-replay-write-noop',
      async () => {
        fs.writeFileSync(syncPath, 'recorded-sync', 'utf8');
        await writeFilePromise(promisePath, 'recorded-promise', 'utf8');
        await writeFileCallback(callbackPath, 'recorded-callback');
      },
      { interceptors: ['fs'] }
    );

    await Promise.all([rm(syncPath), rm(promisePath), rm(callbackPath)]);

    const replayed = await ghost.replay(trace, async () => {
      fs.writeFileSync(syncPath, 'live-sync', 'utf8');
      await writeFilePromise(promisePath, 'live-promise', 'utf8');
      await writeFileCallback(callbackPath, 'live-callback');

      return {
        syncExists: fs.existsSync(syncPath),
        promiseExists: fs.existsSync(promisePath),
        callbackExists: fs.existsSync(callbackPath)
      };
    });

    expect(replayed.output).toEqual({
      syncExists: false,
      promiseExists: false,
      callbackExists: false
    });
    expect(replayed.spansMatched.map((match) => match.span.name)).toEqual([
      'fs.writeFileSync',
      'fs.promises.writeFile',
      'fs.writeFile'
    ]);
  });
});
