import { chmod, readFile } from 'node:fs/promises';

const cliEntry = new URL('../dist/cli/index.mjs', import.meta.url);
const cliSource = await readFile(cliEntry, 'utf8');

if (!cliSource.startsWith('#!/usr/bin/env node')) {
  throw new Error('CLI entry dist/cli/index.mjs is missing the node shebang');
}

await chmod(cliEntry, 0o755);
