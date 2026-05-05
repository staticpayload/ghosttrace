#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cac, type CAC } from 'cac';
import pc from 'picocolors';
import { VERSION } from '../version.js';

/** Creates the GhostTrace command-line parser. */
export function createCli(): CAC {
  const cli = cac('ghost');

  cli.version(VERSION);
  cli.help();

  cli
    .command('init', 'Initialize GhostTrace configuration')
    .action((): void => {
      console.log(pc.yellow('ghost init will be implemented in a later CLI milestone'));
    });

  return cli;
}

/** Runs the GhostTrace CLI with the provided argv array. */
export function runCli(argv: readonly string[] = process.argv): void {
  if (requestsVersion(argv)) {
    console.log(VERSION);
    return;
  }

  const cli = createCli();
  cli.parse([...argv]);
}

function requestsVersion(argv: readonly string[]): boolean {
  return argv.slice(2).some((arg: string): boolean => arg === '--version' || arg === '-v');
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  runCli(process.argv);
}
