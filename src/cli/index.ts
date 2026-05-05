#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cac, type CAC } from 'cac';
import pc from 'picocolors';
import {
  createTracer,
  defineConfig,
  wrap,
  type GhostTraceConfig,
  type RecordedTrace,
  type RecordOptions,
  type TraceableFunction
} from '../index.js';
import { VERSION } from '../version.js';

const DEFAULT_TRACE_DIRECTORY = '__ghosttraces__';
const CONFIG_FILE_NAME = 'ghosttrace.config.ts';
const CONFIG_FILE_NAMES = [
  CONFIG_FILE_NAME,
  'ghosttrace.config.mts',
  'ghosttrace.config.js',
  'ghosttrace.config.mjs',
  'ghosttrace.config.cjs'
] as const;
const VITEST_CONFIG_FILES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs'
] as const;
const JEST_CONFIG_FILES = [
  'jest.config.ts',
  'jest.config.js',
  'jest.config.mjs',
  'jest.config.cjs'
] as const;
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const CONFIG_KEYS = ['traceDir', 'interceptors', 'redaction', 'metadata'] as const;

type DetectedFramework = 'vitest' | 'jest' | 'node';
type CliTargetFunction = (...args: unknown[]) => unknown;

interface CliErrorOptions {
  readonly exitImmediately?: boolean;
}

interface RecordCommandOptions {
  readonly args?: unknown;
  readonly output?: unknown;
  readonly timeout?: unknown;
  readonly name?: unknown;
  readonly interceptors?: unknown;
}

interface PackageJsonLike {
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
  readonly peerDependencies?: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, unknown>>;
}

class CliError extends Error {
  readonly exitImmediately: boolean;

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = 'CliError';
    this.exitImmediately = options.exitImmediately ?? false;
  }
}

/** Creates the GhostTrace command-line parser. */
export function createCli(): CAC {
  const cli = cac('ghost');

  cli.version(VERSION);
  cli.help();

  cli
    .command('init', 'Initialize GhostTrace configuration')
    .action(async (): Promise<void> => {
      await runInitCommand(process.cwd());
    });

  cli
    .command('record [file] [exportName]', 'Record a trace from a module export')
    .option('--args <json>', 'JSON array of arguments to pass to the export')
    .option('--output <path>', 'Trace output file or directory')
    .option('--timeout <ms>', 'Abort recording after the given timeout in milliseconds')
    .option('--name <name>', 'Trace name to store in the output file')
    .option('--interceptors <names>', 'Comma-separated interceptor names to enable')
    .action(async (file: string | undefined, exportName: string | undefined, options: RecordCommandOptions): Promise<void> => {
      await runRecordCommand(process.cwd(), file, exportName, options);
    });

  return cli;
}

/** Runs the GhostTrace CLI with the provided argv array. */
export async function runCli(argv: readonly string[] = process.argv): Promise<number> {
  if (requestsVersion(argv)) {
    console.log(VERSION);
    return 0;
  }

  const cli = createCli();
  try {
    const parsed = cli.parse([...argv], { run: false });
    if (cli.matchedCommand === undefined && parsed.args.length > 0) {
      throw new CliError(`Unknown command "${parsed.args[0]}". Run "ghost --help" for available commands.`);
    }

    const actionResult: unknown = cli.runMatchedCommand();
    if (isPromiseLike(actionResult)) {
      await actionResult;
    }

    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(message));

    if (error instanceof CliError && error.exitImmediately) {
      process.exit(1);
    }

    process.exitCode = 1;
    return 1;
  }
}

function requestsVersion(argv: readonly string[]): boolean {
  return argv.slice(2).some((arg: string): boolean => arg === '--version' || arg === '-v');
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }

  return typeof (value as { readonly then?: unknown }).then === 'function';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(path: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  return isRecord(parsed) ? parsed : undefined;
}

function packageJsonLike(value: Readonly<Record<string, unknown>> | undefined): PackageJsonLike {
  if (value === undefined) {
    return {};
  }

  const result: {
    dependencies?: Readonly<Record<string, unknown>>;
    devDependencies?: Readonly<Record<string, unknown>>;
    peerDependencies?: Readonly<Record<string, unknown>>;
    optionalDependencies?: Readonly<Record<string, unknown>>;
  } = {};

  for (const field of DEPENDENCY_FIELDS) {
    const candidate = value[field];
    if (isRecord(candidate)) {
      result[field] = candidate;
    }
  }

  return result;
}

function hasPackageDependency(packageJson: PackageJsonLike, dependencyName: string): boolean {
  return DEPENDENCY_FIELDS.some((field): boolean => packageJson[field]?.[dependencyName] !== undefined);
}

async function hasAnyConfigFile(cwd: string, fileNames: readonly string[]): Promise<boolean> {
  for (const fileName of fileNames) {
    if (await pathExists(join(cwd, fileName))) {
      return true;
    }
  }

  return false;
}

async function detectFramework(cwd: string): Promise<DetectedFramework> {
  const packageJson = packageJsonLike(await readJsonObject(join(cwd, 'package.json')));

  if (hasPackageDependency(packageJson, 'vitest') || (await hasAnyConfigFile(cwd, VITEST_CONFIG_FILES))) {
    return 'vitest';
  }

  if (hasPackageDependency(packageJson, 'jest') || (await hasAnyConfigFile(cwd, JEST_CONFIG_FILES))) {
    return 'jest';
  }

  return 'node';
}

function configFileContents(framework: DetectedFramework): string {
  return [
    "import { defineConfig } from 'ghosttrace';",
    '',
    'export default defineConfig({',
    `  traceDir: '${DEFAULT_TRACE_DIRECTORY}',`,
    "  interceptors: ['function', 'http', 'timer', 'random', 'env', 'fs'],",
    '  metadata: {',
    `    framework: '${framework}'`,
    '  }',
    '});',
    ''
  ].join('\n');
}

async function runInitCommand(cwd: string): Promise<void> {
  const framework = await detectFramework(cwd);
  const traceDirectory = join(cwd, DEFAULT_TRACE_DIRECTORY);
  const configPath = join(cwd, CONFIG_FILE_NAME);

  await mkdir(traceDirectory, { recursive: true });

  if (await pathExists(configPath)) {
    console.log(pc.yellow(`${CONFIG_FILE_NAME} already exists; leaving it unchanged.`));
  } else {
    await writeFile(configPath, configFileContents(framework), { encoding: 'utf8', flag: 'wx' });
    console.log(pc.green(`Created ${CONFIG_FILE_NAME}`));
  }

  console.log(pc.green(`Created ${DEFAULT_TRACE_DIRECTORY}/`));
  console.log(`Detected framework: ${framework}`);
}

async function findConfig(startDirectory: string): Promise<string | undefined> {
  let currentDirectory = resolve(startDirectory);

  while (true) {
    for (const fileName of CONFIG_FILE_NAMES) {
      const candidate = join(currentDirectory, fileName);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function isTypeScriptPath(path: string): boolean {
  return TYPESCRIPT_EXTENSIONS.has(path.slice(path.lastIndexOf('.')));
}

function cacheBustedFileUrl(path: string): string {
  const url = pathToFileURL(path);
  url.searchParams.set('ghosttraceCacheBust', `${Date.now()}-${Math.random()}`);
  return url.href;
}

async function importModule(path: string): Promise<Readonly<Record<string, unknown>>> {
  const specifier = cacheBustedFileUrl(path);
  const imported: unknown = isTypeScriptPath(path)
    ? await importTypeScriptModule(specifier)
    : await import(specifier);

  if (!isRecord(imported)) {
    throw new CliError(`Module ${path} did not load to an export object`);
  }

  return imported;
}

async function importTypeScriptModule(specifier: string): Promise<unknown> {
  const tsxApi: typeof import('tsx/esm/api') = await import('tsx/esm/api');
  return tsxApi.tsImport(specifier, { parentURL: pathToFileURL(`${process.cwd()}/`).href });
}

function normalizeLoadedConfig(value: unknown, configPath: string): GhostTraceConfig {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new CliError(`Config file ${configPath} must export a GhostTrace config object`);
  }

  const config: {
    traceDir?: string;
    interceptors?: readonly string[];
    redaction?: NonNullable<GhostTraceConfig['redaction']>;
    metadata?: NonNullable<GhostTraceConfig['metadata']>;
  } = {};

  if (value.traceDir !== undefined) {
    if (typeof value.traceDir !== 'string') {
      throw new CliError(`Config file ${configPath} has a non-string traceDir`);
    }
    config.traceDir = value.traceDir;
  }

  if (value.interceptors !== undefined) {
    if (!Array.isArray(value.interceptors) || !value.interceptors.every((entry): entry is string => typeof entry === 'string')) {
      throw new CliError(`Config file ${configPath} has invalid interceptors; expected string[]`);
    }
    config.interceptors = value.interceptors;
  }

  if (value.redaction !== undefined) {
    config.redaction = value.redaction as NonNullable<GhostTraceConfig['redaction']>;
  }

  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      throw new CliError(`Config file ${configPath} has invalid metadata; expected object`);
    }
    config.metadata = value.metadata;
  }

  return defineConfig(config);
}

async function loadConfig(cwd: string): Promise<GhostTraceConfig> {
  const configPath = await findConfig(cwd);
  if (configPath === undefined) {
    return {};
  }

  const configModule = await importModule(configPath);
  const loadedConfig = resolveConfigExport(configModule);
  return normalizeLoadedConfig(loadedConfig, configPath);
}

function hasConfigKey(value: unknown): boolean {
  return isRecord(value) && CONFIG_KEYS.some((key): boolean => value[key] !== undefined);
}

function resolveConfigExport(configModule: Readonly<Record<string, unknown>>): unknown {
  const directConfig = configModule.default ?? configModule.config;

  if (directConfig === undefined || hasConfigKey(directConfig) || !isRecord(directConfig)) {
    return directConfig;
  }

  return directConfig.default ?? directConfig.config ?? directConfig;
}

function optionalOptionValue(value: unknown): unknown {
  return value === false ? undefined : value;
}

function requireString(value: unknown, description: string): string | undefined {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return undefined;
  }

  if (typeof optionValue !== 'string') {
    throw new CliError(`${description} must be a string`);
  }

  return optionValue;
}

function parseArgsOption(value: unknown): readonly unknown[] {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return [];
  }

  if (typeof optionValue !== 'string') {
    throw new CliError('--args must be a JSON array string');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(optionValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to parse --args as JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new CliError('--args must parse to a JSON array');
  }

  return parsed;
}

function parseTimeoutOption(value: unknown): number | undefined {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return undefined;
  }

  const timeoutMs = typeof optionValue === 'number' ? optionValue : Number(optionValue);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CliError('--timeout must be a positive number of milliseconds');
  }

  return timeoutMs;
}

function parseInterceptorsOption(value: unknown): readonly string[] | undefined {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return undefined;
  }

  const rawValues = Array.isArray(optionValue) ? optionValue : [optionValue];
  const interceptors = rawValues.flatMap((rawValue): readonly string[] => {
    if (typeof rawValue !== 'string') {
      throw new CliError('--interceptors must be a comma-separated string');
    }

    return rawValue.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  });

  if (interceptors.length === 0) {
    throw new CliError('--interceptors must include at least one interceptor name');
  }

  return interceptors;
}

function selectedExport(moduleExports: Readonly<Record<string, unknown>>, exportName: string): unknown {
  if (Object.prototype.hasOwnProperty.call(moduleExports, exportName)) {
    return moduleExports[exportName];
  }

  if (isRecord(moduleExports.default) && Object.prototype.hasOwnProperty.call(moduleExports.default, exportName)) {
    return moduleExports.default[exportName];
  }

  throw new CliError(`Export "${exportName}" was not found in the target module`);
}

function assertTargetFunction(value: unknown, exportName: string): CliTargetFunction {
  if (typeof value !== 'function') {
    throw new CliError(`Export "${exportName}" is not a function`);
  }

  return value as CliTargetFunction;
}

function withTimeout<TValue>(
  operation: Promise<TValue>,
  timeoutMs: number | undefined
): Promise<TValue> {
  if (timeoutMs === undefined) {
    return operation;
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<TValue>((_resolve, reject): void => {
    timeout = setTimeout((): void => {
      reject(new CliError(`Recording timed out after ${timeoutMs}ms`, { exitImmediately: true }));
    }, timeoutMs);
  });

  return Promise.race([operation, timeoutPromise]).finally((): void => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

async function recordTrace(
  config: GhostTraceConfig,
  traceName: string,
  targetFunction: CliTargetFunction,
  args: readonly unknown[],
  interceptors: readonly string[] | undefined
): Promise<RecordedTrace> {
  const tracer = createTracer(config);
  const wrappedTarget = wrap(targetFunction);
  const options: RecordOptions = {
    metadata: {
      source: 'cli'
    },
    ...(interceptors === undefined ? {} : { interceptors })
  };

  return tracer.record(traceName, (() => wrappedTarget(...args)) as TraceableFunction<unknown>, options);
}

function defaultTraceSaveTarget(cwd: string, config: GhostTraceConfig): { readonly directory: string } {
  return {
    directory: resolve(cwd, config.traceDir ?? DEFAULT_TRACE_DIRECTORY)
  };
}

async function runRecordCommand(
  cwd: string,
  file: string | undefined,
  exportName: string | undefined,
  options: RecordCommandOptions
): Promise<void> {
  if (file === undefined || exportName === undefined) {
    throw new CliError('Usage: ghost record <file> <export> [--args JSON_ARRAY]');
  }

  const filePath = resolve(cwd, file);
  if (!(await pathExists(filePath))) {
    throw new CliError(`File not found: ${file}`);
  }

  const args = parseArgsOption(options.args);
  const output = requireString(options.output, '--output');
  const traceName = requireString(options.name, '--name') ?? exportName;
  const timeoutMs = parseTimeoutOption(options.timeout);
  const interceptors = parseInterceptorsOption(options.interceptors);
  const config = await loadConfig(cwd);
  const moduleExports = await importModule(filePath);
  const targetFunction = assertTargetFunction(selectedExport(moduleExports, exportName), exportName);

  const trace = await withTimeout(recordTrace(config, traceName, targetFunction, args, interceptors), timeoutMs);
  const savedPath = await trace.save(output ?? defaultTraceSaveTarget(cwd, config));

  console.log(pc.green(`Trace saved to ${resolve(cwd, savedPath)}`));
}

if (isDirectExecution()) {
  void runCli(process.argv).then((exitCode: number): void => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
