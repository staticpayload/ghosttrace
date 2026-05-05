#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect, isDeepStrictEqual } from 'node:util';
import { cac, type CAC } from 'cac';
import pc from 'picocolors';
import {
  createTracer,
  defineConfig,
  deserialize,
  diff,
  exportTrace,
  generateFixtures,
  generateMocks,
  generateTests,
  replay,
  SpanType,
  validateTrace,
  wrap,
  type DiffChange,
  type DiffOptions,
  type DiffResult,
  type FixtureGenerationFormat,
  type GhostTraceConfig,
  type JsonExportMode,
  type MermaidExportMode,
  type MockGenerationFormat,
  type RecordedTrace,
  type RecordOptions,
  type ReplayMode,
  type ReplayOptions,
  type SerializedJsonValue,
  type Span,
  type TestGenerationFramework,
  type Trace,
  type TraceExportFormat,
  type TraceValidationResult,
  type TraceableFunction
} from '../index.js';
import { loadValidatedTrace } from '../validation/index.js';
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
const REPLAY_MODES = ['strict', 'lenient', 'partial'] as const satisfies readonly ReplayMode[];
const DIFF_FORMATS = ['terminal', 'json', 'html'] as const;
const DIFF_FAIL_ON_VALUES = ['breaking', 'drift', 'any', 'none'] as const;
const EXPORT_FORMATS = ['json', 'markdown', 'mermaid', 'html'] as const satisfies readonly TraceExportFormat[];
const JSON_EXPORT_MODES = ['pretty', 'compact'] as const satisfies readonly JsonExportMode[];
const MERMAID_EXPORT_MODES = ['sequence', 'flowchart'] as const satisfies readonly MermaidExportMode[];
const TOP_LEVEL_COMMANDS = ['init', 'record', 'replay', 'diff', 'export', 'inspect', 'generate'] as const;
const GENERATE_SUBCOMMANDS = ['mocks', 'fixtures', 'tests'] as const;
const MOCK_GENERATE_FRAMEWORKS = ['function', 'vitest', 'jest'] as const;
const FIXTURE_GENERATE_FORMATS = ['json', 'typescript'] as const satisfies readonly FixtureGenerationFormat[];
const TEST_GENERATE_FRAMEWORKS = ['vitest', 'jest'] as const satisfies readonly TestGenerationFramework[];

type DetectedFramework = 'vitest' | 'jest' | 'node';
type CliTargetFunction = (...args: unknown[]) => unknown;
type DiffReportFormat = (typeof DIFF_FORMATS)[number];
type DiffFailOn = (typeof DIFF_FAIL_ON_VALUES)[number];
type ExportFormatterMode = JsonExportMode | MermaidExportMode;
type GenerateSubcommand = (typeof GENERATE_SUBCOMMANDS)[number];
type MockGenerateFramework = (typeof MOCK_GENERATE_FRAMEWORKS)[number];
type GenerateFramework = MockGenerateFramework | FixtureGenerationFormat | TestGenerationFramework;

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

interface ReplayCommandOptions {
  readonly args?: unknown;
  readonly mode?: unknown;
  readonly replayTypes?: unknown;
  readonly timeout?: unknown;
}

interface DiffCommandOptions {
  readonly format?: unknown;
  readonly failOn?: unknown;
  readonly rules?: unknown;
  readonly output?: unknown;
}

interface ExportCommandOptions {
  readonly format?: unknown;
  readonly output?: unknown;
  readonly mode?: unknown;
}

interface InspectCommandOptions {
  readonly spans?: unknown;
  readonly span?: unknown;
  readonly validate?: unknown;
}

interface GenerateCommandOptions {
  readonly framework?: unknown;
  readonly output?: unknown;
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

  cli
    .command('replay [trace] [file] [exportName]', 'Replay a module export against a recorded trace')
    .option('--args <json>', 'JSON array of arguments to pass to the export')
    .option('--mode <mode>', 'Replay mode: strict, lenient, or partial')
    .option('--replay-types <types>', 'Comma-separated span types to replay in partial mode')
    .option('--timeout <ms>', 'Abort replay after the given timeout in milliseconds')
    .action(async (
      tracePath: string | undefined,
      file: string | undefined,
      exportName: string | undefined,
      options: ReplayCommandOptions
    ): Promise<void> => {
      await runReplayCommand(process.cwd(), tracePath, file, exportName, options);
    });

  cli
    .command('diff [baseline] [current]', 'Compare two GhostTrace trace files')
    .option('--format <format>', 'Report format: terminal, json, or html')
    .option('--fail-on <severity>', 'Exit 1 when the diff reaches severity: breaking, drift, any, or none')
    .option('--rules <path>', 'JSON diff rules file')
    .option('--output <path>', 'Write the diff report to a file instead of stdout')
    .action(async (
      baselinePath: string | undefined,
      currentPath: string | undefined,
      options: DiffCommandOptions
    ): Promise<void> => {
      await runDiffCommand(process.cwd(), baselinePath, currentPath, options);
    });

  cli
    .command('export [trace]', 'Export a trace to json, markdown, mermaid, or html')
    .option('--format <format>', 'Export format: json, markdown, mermaid, or html')
    .option('--output <path>', 'Write the export output to a file')
    .option('--mode <mode>', 'Formatter mode: pretty/compact for JSON, sequence/flowchart for Mermaid')
    .action(async (tracePath: string | undefined, options: ExportCommandOptions): Promise<void> => {
      await runExportCommand(process.cwd(), tracePath, options);
    });

  cli
    .command('inspect [trace]', 'Inspect a GhostTrace trace file')
    .option('--spans', 'List every span in the trace')
    .option('--span <id>', 'Show full detail for a specific span ID')
    .option('--validate', 'Validate trace schema and checksum integrity')
    .action(async (tracePath: string | undefined, options: InspectCommandOptions): Promise<void> => {
      await runInspectCommand(process.cwd(), tracePath, options);
    });

  cli
    .command('generate [kind] [trace]', 'Generate mocks, fixtures, or replay tests from a trace')
    .option('--framework <framework>', 'mocks: function/vitest/jest; fixtures: json/typescript; tests: vitest/jest')
    .option('--output <dir>', 'Directory for generated files')
    .action(async (kind: string | undefined, tracePath: string | undefined, options: GenerateCommandOptions): Promise<void> => {
      await runGenerateCommand(process.cwd(), kind, tracePath, options);
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
      throw new CliError(`Unknown command "${parsed.args[0]}". Available commands: ${TOP_LEVEL_COMMANDS.join(', ')}. Run "ghost --help" for usage.`);
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

function parseReplayModeOption(value: unknown): ReplayMode | undefined {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return undefined;
  }
  if (typeof optionValue !== 'string' || !REPLAY_MODES.includes(optionValue as ReplayMode)) {
    throw new CliError(`--mode must be one of: ${REPLAY_MODES.join(', ')}`);
  }

  return optionValue as ReplayMode;
}

function isSpanType(value: string): value is SpanType {
  return (Object.values(SpanType) as readonly string[]).includes(value);
}

function parseReplayTypesOption(value: unknown): readonly SpanType[] | undefined {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return undefined;
  }

  const rawValues = Array.isArray(optionValue) ? optionValue : [optionValue];
  const replayTypes = rawValues.flatMap((rawValue): readonly SpanType[] => {
    if (typeof rawValue !== 'string') {
      throw new CliError('--replay-types must be a comma-separated string');
    }

    return rawValue.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0).map((entry) => {
      if (!isSpanType(entry)) {
        throw new CliError(`Unknown replay span type "${entry}". Expected one of: ${Object.values(SpanType).join(', ')}`);
      }

      return entry;
    });
  });

  if (replayTypes.length === 0) {
    throw new CliError('--replay-types must include at least one span type');
  }

  return replayTypes;
}

function parseDiffFormatOption(value: unknown): DiffReportFormat {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return 'terminal';
  }
  if (typeof optionValue !== 'string' || !DIFF_FORMATS.includes(optionValue as DiffReportFormat)) {
    throw new CliError(`--format must be one of: ${DIFF_FORMATS.join(', ')}`);
  }

  return optionValue as DiffReportFormat;
}

function parseDiffFailOnOption(value: unknown): DiffFailOn {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return 'none';
  }
  if (typeof optionValue !== 'string' || !DIFF_FAIL_ON_VALUES.includes(optionValue as DiffFailOn)) {
    throw new CliError(`--fail-on must be one of: ${DIFF_FAIL_ON_VALUES.join(', ')}`);
  }

  return optionValue as DiffFailOn;
}

function parseExportFormatOption(value: unknown): TraceExportFormat {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    throw new CliError(`--format is required and must be one of: ${EXPORT_FORMATS.join(', ')}`);
  }
  if (typeof optionValue !== 'string' || !EXPORT_FORMATS.includes(optionValue as TraceExportFormat)) {
    throw new CliError(`--format must be one of: ${EXPORT_FORMATS.join(', ')}`);
  }

  return optionValue as TraceExportFormat;
}

function parseExportModeOption(format: TraceExportFormat, value: unknown): ExportFormatterMode | undefined {
  const optionValue = optionalOptionValue(value);
  if (optionValue === undefined) {
    return undefined;
  }
  if (typeof optionValue !== 'string') {
    throw new CliError('--mode must be a string');
  }

  if (format === 'json') {
    if (!JSON_EXPORT_MODES.includes(optionValue as JsonExportMode)) {
      throw new CliError(`--mode for JSON export must be one of: ${JSON_EXPORT_MODES.join(', ')}`);
    }

    return optionValue as JsonExportMode;
  }

  if (format === 'mermaid') {
    if (!MERMAID_EXPORT_MODES.includes(optionValue as MermaidExportMode)) {
      throw new CliError(`--mode for Mermaid export must be one of: ${MERMAID_EXPORT_MODES.join(', ')}`);
    }

    return optionValue as MermaidExportMode;
  }

  throw new CliError(`--mode is only supported for json and mermaid exports, not ${format}`);
}

function parseSpanIdOption(value: unknown): string | undefined {
  return requireString(value, '--span');
}

function isEnabledFlag(value: unknown): boolean {
  return optionalOptionValue(value) === true;
}

function parseGenerateSubcommand(value: string | undefined): GenerateSubcommand {
  if (value === undefined) {
    throw new CliError('Usage: ghost generate <mocks|fixtures|tests> <trace> [--framework name] [--output dir]');
  }
  if (!GENERATE_SUBCOMMANDS.includes(value as GenerateSubcommand)) {
    throw new CliError(`Unknown generate subcommand "${value}". Expected one of: ${GENERATE_SUBCOMMANDS.join(', ')}`);
  }

  return value as GenerateSubcommand;
}

function configMetadataString(config: GhostTraceConfig, key: string): string | undefined {
  const value = config.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function defaultGenerateFramework(kind: GenerateSubcommand, config: GhostTraceConfig): string | undefined {
  const explicitGenerateFramework = configMetadataString(config, 'generateFramework');
  if (explicitGenerateFramework !== undefined) {
    return explicitGenerateFramework;
  }

  if (kind === 'fixtures') {
    return configMetadataString(config, 'fixtureFormat');
  }

  const detectedFramework = configMetadataString(config, 'framework');
  if (kind === 'mocks') {
    return detectedFramework === 'node' ? 'function' : detectedFramework;
  }
  if (detectedFramework === 'vitest' || detectedFramework === 'jest') {
    return detectedFramework;
  }

  return undefined;
}

function parseGenerateFrameworkValue<const TFramework extends string>(
  kind: GenerateSubcommand,
  rawValue: unknown,
  config: GhostTraceConfig,
  validValues: readonly TFramework[],
  defaultValue: TFramework
): TFramework {
  const explicitValue = requireString(rawValue, '--framework');
  const candidate = explicitValue ?? defaultGenerateFramework(kind, config) ?? defaultValue;
  if (!validValues.includes(candidate as TFramework)) {
    throw new CliError(`--framework for ${kind} must be one of: ${validValues.join(', ')}`);
  }

  return candidate as TFramework;
}

function parseGenerateFramework(
  kind: GenerateSubcommand,
  rawValue: unknown,
  config: GhostTraceConfig
): GenerateFramework {
  if (kind === 'mocks') {
    return parseGenerateFrameworkValue(kind, rawValue, config, MOCK_GENERATE_FRAMEWORKS, 'function');
  }
  if (kind === 'fixtures') {
    return parseGenerateFrameworkValue(kind, rawValue, config, FIXTURE_GENERATE_FORMATS, 'json');
  }

  return parseGenerateFrameworkValue(kind, rawValue, config, TEST_GENERATE_FRAMEWORKS, 'vitest');
}

function mockFormatFromFramework(framework: GenerateFramework): MockGenerationFormat {
  if (framework === 'vitest') {
    return 'vitest-mock';
  }
  if (framework === 'jest') {
    return 'jest-mock';
  }

  return 'function';
}

function outputDirectoryFromOptions(cwd: string, config: GhostTraceConfig, value: unknown): string | undefined {
  const output = requireString(value, '--output');
  if (output !== undefined) {
    return resolve(cwd, output);
  }
  if (config.traceDir !== undefined) {
    return resolve(cwd, config.traceDir);
  }

  return undefined;
}

function generatedFileBaseName(trace: Trace): string {
  const sanitized = trace.name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
    .replace(/^-+|-+$/gu, '');

  return sanitized.length === 0 ? 'trace' : sanitized;
}

function optionalStringArray(value: unknown, description: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
    throw new CliError(`${description} must be an array of strings`);
  }

  return value;
}

function optionalBoolean(value: unknown, description: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new CliError(`${description} must be a boolean`);
  }

  return value;
}

function normalizeDiffRules(value: unknown, sourcePath: string): DiffOptions {
  if (!isRecord(value)) {
    throw new CliError(`Rules file ${sourcePath} must contain a JSON object`);
  }

  const candidate = isRecord(value.diff) ? value.diff : value;
  const rules: {
    ignorePaths?: readonly string[];
    allowNewSpans?: boolean;
    allowRemovedSpans?: boolean;
    breakingOn?: readonly string[];
  } = {};
  const ignorePaths = optionalStringArray(candidate.ignorePaths, 'rules.ignorePaths');
  const allowNewSpans = optionalBoolean(candidate.allowNewSpans, 'rules.allowNewSpans');
  const allowRemovedSpans = optionalBoolean(candidate.allowRemovedSpans, 'rules.allowRemovedSpans');
  const breakingOn = optionalStringArray(candidate.breakingOn, 'rules.breakingOn');

  if (ignorePaths !== undefined) {
    rules.ignorePaths = ignorePaths;
  }
  if (allowNewSpans !== undefined) {
    rules.allowNewSpans = allowNewSpans;
  }
  if (allowRemovedSpans !== undefined) {
    rules.allowRemovedSpans = allowRemovedSpans;
  }
  if (breakingOn !== undefined) {
    rules.breakingOn = breakingOn;
  }

  return rules;
}

async function loadDiffRules(cwd: string, value: unknown): Promise<{ readonly options: DiffOptions; readonly path: string } | undefined> {
  const rulesPath = requireString(value, '--rules');
  if (rulesPath === undefined) {
    return undefined;
  }

  const absolutePath = resolve(cwd, rulesPath);
  if (!(await pathExists(absolutePath))) {
    throw new CliError(`Rules file not found: ${rulesPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Failed to parse rules file ${rulesPath}: ${message}`);
  }

  return {
    options: normalizeDiffRules(parsed, rulesPath),
    path: absolutePath
  };
}

function formatValue(value: unknown): string {
  return inspect(value, {
    colors: false,
    depth: 8,
    breakLength: 100,
    sorted: true
  });
}

function findReplayExpectationSpan(trace: Trace): Span {
  const rootFunctionSpan = trace.spans.find((span) => span.type === SpanType.Function && span.parentId === null);
  const fallbackSpan = rootFunctionSpan ?? trace.spans[0];

  if (fallbackSpan === undefined) {
    throw new CliError(`Trace ${trace.name} does not contain any spans to replay against`);
  }

  return fallbackSpan;
}

function deserializeTraceValue(value: unknown): unknown {
  return deserialize(value as SerializedJsonValue);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : error === null ? 'null' : typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordedErrorMatches(error: unknown, recorded: Span['error']): boolean {
  if (recorded === null) {
    return false;
  }

  return errorName(error) === recorded.name && errorMessage(error) === recorded.message;
}

function writeReplayPass(trace: Trace, mode: ReplayMode): void {
  console.log(pc.green(`PASS replay matched ${trace.name} (${mode})`));
}

function writeReplayOutputMismatch(trace: Trace, expected: unknown, actual: unknown): void {
  console.error(pc.red(`FAIL replay mismatch for ${trace.name}`));
  console.error('Output mismatch:');
  console.error(`Expected: ${formatValue(expected)}`);
  console.error(`Actual:   ${formatValue(actual)}`);
}

function writeReplayErrorMismatch(trace: Trace, error: unknown): void {
  console.error(pc.red(`FAIL replay mismatch for ${trace.name}`));
  console.error(`Replay failed: ${errorName(error)}: ${errorMessage(error)}`);
}

function diffStatusText(result: DiffResult): string {
  if (result.status === 'identical') {
    return pc.green(result.status);
  }
  if (result.status === 'breaking') {
    return pc.red(result.status);
  }

  return pc.yellow(result.status);
}

function diffSeverityText(severity: DiffChange['severity']): string {
  return severity === 'breaking' ? pc.red(severity.toUpperCase()) : pc.yellow(severity.toUpperCase());
}

function formatDiffChange(change: DiffChange): string {
  const prefix = `${diffSeverityText(change.severity)} ${change.type} ${change.spanPath} ${change.field}`;

  if (change.type === 'changed') {
    return [
      prefix,
      `  Expected: ${formatValue(change.baseline)}`,
      `  Actual:   ${formatValue(change.current)}`
    ].join('\n');
  }

  if (change.type === 'added') {
    return [
      prefix,
      `  Added: ${formatValue({
        id: change.current.id,
        type: change.current.type,
        name: change.current.name
      })}`
    ].join('\n');
  }

  return [
    prefix,
    `  Removed: ${formatValue({
      id: change.baseline.id,
      type: change.baseline.type,
      name: change.baseline.name
    })}`
  ].join('\n');
}

function renderTerminalDiffReport(result: DiffResult, rulesPath: string | undefined): string {
  const lines: string[] = [];

  if (rulesPath !== undefined) {
    lines.push(`Applied rules: ${rulesPath}`);
  }

  lines.push(`Diff status: ${diffStatusText(result)}`);
  lines.push(result.summary);
  lines.push(
    `Stats: ${result.stats.breaking} breaking, ${result.stats.drift} drift, ${result.stats.added} added, ${result.stats.removed} removed, ${result.stats.changed} changed`
  );

  if (result.changes.length > 0) {
    lines.push('');
    lines.push('Changes:');
    lines.push(...result.changes.map(formatDiffChange));
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    lines.push(...result.warnings.map((warning) => `${warning.path}: ${warning.message}`));
  }

  return `${lines.join('\n')}\n`;
}

function shouldFailOnDiff(result: DiffResult, failOn: DiffFailOn): boolean {
  if (failOn === 'none') {
    return false;
  }
  if (failOn === 'breaking') {
    return result.stats.breaking > 0;
  }
  if (failOn === 'drift') {
    return result.stats.breaking > 0 || result.stats.drift > 0;
  }

  return result.stats.total > 0;
}

async function writeTextOutput(outputPath: string, content: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, 'utf8');
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

async function runReplayCommand(
  cwd: string,
  tracePath: string | undefined,
  file: string | undefined,
  exportName: string | undefined,
  options: ReplayCommandOptions
): Promise<void> {
  if (tracePath === undefined || file === undefined || exportName === undefined) {
    throw new CliError('Usage: ghost replay <trace> <file> <export> [--args JSON_ARRAY] [--mode strict|lenient|partial]');
  }

  const filePath = resolve(cwd, file);
  if (!(await pathExists(filePath))) {
    throw new CliError(`File not found: ${file}`);
  }

  const args = parseArgsOption(options.args);
  const mode = parseReplayModeOption(options.mode) ?? 'strict';
  const replayTypes = parseReplayTypesOption(options.replayTypes);
  const timeoutMs = parseTimeoutOption(options.timeout);
  const trace = await loadValidatedTrace(resolve(cwd, tracePath), 'replay');
  const expectedSpan = findReplayExpectationSpan(trace);
  const moduleExports = await importModule(filePath);
  const targetFunction = assertTargetFunction(selectedExport(moduleExports, exportName), exportName);
  const replayOptions: {
    mode: ReplayMode;
    replayTypes?: readonly SpanType[];
    timeout?: number;
  } = { mode };

  if (replayTypes !== undefined) {
    replayOptions.replayTypes = replayTypes;
  }
  if (timeoutMs !== undefined) {
    replayOptions.timeout = timeoutMs;
  }

  try {
    const result = await replay(
      trace,
      (() => targetFunction(...args)) as TraceableFunction<unknown>,
      replayOptions satisfies ReplayOptions
    );

    if (expectedSpan.error !== null) {
      writeReplayOutputMismatch(trace, `${expectedSpan.error.name}: ${expectedSpan.error.message}`, result.output);
      process.exitCode = 1;
      return;
    }

    const expectedOutput = deserializeTraceValue(expectedSpan.output);
    if (!isDeepStrictEqual(expectedOutput, result.output)) {
      writeReplayOutputMismatch(trace, expectedOutput, result.output);
      process.exitCode = 1;
      return;
    }

    writeReplayPass(trace, mode);
  } catch (error) {
    if (recordedErrorMatches(error, expectedSpan.error)) {
      writeReplayPass(trace, mode);
      return;
    }

    writeReplayErrorMismatch(trace, error);
    process.exitCode = 1;
  }
}

async function renderDiffReport(
  format: DiffReportFormat,
  baselineTrace: Trace,
  currentTrace: Trace,
  result: DiffResult,
  rulesPath: string | undefined
): Promise<string> {
  if (format === 'json') {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === 'html') {
    return exportTrace(currentTrace, {
      format: 'html',
      diff: result,
      baselineTrace
    });
  }

  return renderTerminalDiffReport(result, rulesPath);
}

async function runDiffCommand(
  cwd: string,
  baselinePath: string | undefined,
  currentPath: string | undefined,
  options: DiffCommandOptions
): Promise<void> {
  if (baselinePath === undefined || currentPath === undefined) {
    throw new CliError('Usage: ghost diff <baseline-trace> <current-trace> [--format terminal|json|html]');
  }

  const format = parseDiffFormatOption(options.format);
  const failOn = parseDiffFailOnOption(options.failOn);
  const output = requireString(options.output, '--output');
  const rules = await loadDiffRules(cwd, options.rules);
  const baselineTrace = await loadValidatedTrace(resolve(cwd, baselinePath), 'baseline');
  const currentTrace = await loadValidatedTrace(resolve(cwd, currentPath), 'current');
  const result = diff(baselineTrace, currentTrace, rules?.options) as DiffResult;
  const report = await renderDiffReport(format, baselineTrace, currentTrace, result, rules?.path);

  if (output === undefined) {
    process.stdout.write(report);
  } else {
    const outputPath = resolve(cwd, output);
    await writeTextOutput(outputPath, report);
    console.log(pc.green(`Diff report written to ${outputPath}`));
  }

  if (shouldFailOnDiff(result, failOn)) {
    console.error(pc.red(`Diff contains ${failOn === 'any' ? 'changes' : `${failOn} changes`}; failing because --fail-on ${failOn} was set.`));
    process.exitCode = 1;
  }
}

async function runExportCommand(
  cwd: string,
  tracePath: string | undefined,
  options: ExportCommandOptions
): Promise<void> {
  if (tracePath === undefined) {
    throw new CliError('Usage: ghost export <trace> --format json|markdown|mermaid|html [--output path]');
  }

  const format = parseExportFormatOption(options.format);
  const output = requireString(options.output, '--output');
  const mode = parseExportModeOption(format, options.mode);
  const trace = await loadValidatedTrace(resolve(cwd, tracePath), 'export');
  const exportOptions: {
    format: TraceExportFormat;
    output?: string;
    mode?: ExportFormatterMode;
  } = { format };

  if (output !== undefined) {
    exportOptions.output = resolve(cwd, output);
  }
  if (mode !== undefined) {
    exportOptions.mode = mode;
  }

  const contentOrPath = await exportTrace(trace, exportOptions);
  if (output === undefined) {
    process.stdout.write(contentOrPath);
    return;
  }

  console.log(pc.green(`Exported trace to ${contentOrPath}`));
}

function spanTypeCounts(trace: Trace): ReadonlyMap<SpanType, number> {
  const counts = new Map<SpanType, number>();

  for (const span of trace.spans) {
    counts.set(span.type, (counts.get(span.type) ?? 0) + 1);
  }

  return counts;
}

function renderTraceSummary(trace: Trace): string {
  const counts = spanTypeCounts(trace);
  const errorCount = trace.spans.filter((span) => span.error !== null).length;
  const lines = [
    'Trace summary',
    `Name: ${trace.name}`,
    `ID: ${trace.id}`,
    `Version: ${trace.version}`,
    `Duration: ${trace.duration}ms`,
    `Spans: ${trace.spans.length}`,
    `Errors: ${errorCount}`,
    'Span types:'
  ];

  for (const spanType of Object.values(SpanType)) {
    const count = counts.get(spanType);
    if (count !== undefined) {
      lines.push(`  ${spanType}: ${count}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function spanStatus(span: Span): string {
  return span.error === null ? 'ok' : `error:${span.error.name}`;
}

function renderSpanList(trace: Trace): string {
  const lines = [
    `Spans (${trace.spans.length})`,
    ...trace.spans.map((span) => [
      span.id,
      span.type,
      span.name,
      `duration=${span.duration}ms`,
      `parent=${span.parentId ?? '-'}`,
      spanStatus(span)
    ].join('  '))
  ];

  return `${lines.join('\n')}\n`;
}

function renderSpanDetail(span: Span): string {
  return `Span detail\n${JSON.stringify(span, null, 2)}\n`;
}

function validationIssueLines(label: string, issues: TraceValidationResult['errors']): readonly string[] {
  if (issues.length === 0) {
    return [];
  }

  return [
    `${label}:`,
    ...issues.map((issue) => `  ${issue.code} ${issue.path}: ${issue.message}`)
  ];
}

function renderValidationResult(tracePath: string, result: TraceValidationResult): string {
  const lines = result.valid
    ? [pc.green(`Trace valid: ${tracePath}`)]
    : [pc.red(`Trace invalid: ${tracePath}`)];

  if (result.trace !== undefined) {
    lines.push(`Name: ${result.trace.name}`);
    lines.push(`Spans: ${result.trace.spans.length}`);
  }

  lines.push(...validationIssueLines('Errors', result.errors));
  lines.push(...validationIssueLines('Warnings', result.warnings));

  return `${lines.join('\n')}\n`;
}

async function runInspectCommand(
  cwd: string,
  tracePath: string | undefined,
  options: InspectCommandOptions
): Promise<void> {
  if (tracePath === undefined) {
    throw new CliError('Usage: ghost inspect <trace> [--spans] [--span id] [--validate]');
  }

  const absoluteTracePath = resolve(cwd, tracePath);
  if (isEnabledFlag(options.validate)) {
    const validationResult = await validateTrace(absoluteTracePath);
    process.stdout.write(renderValidationResult(tracePath, validationResult));
    if (!validationResult.valid) {
      process.exitCode = 1;
    }
    return;
  }

  const trace = await loadValidatedTrace(absoluteTracePath, 'inspect');
  const spanId = parseSpanIdOption(options.span);
  if (spanId !== undefined) {
    const matchedSpan = trace.spans.find((span) => span.id === spanId);
    if (matchedSpan === undefined) {
      throw new CliError(`Span not found: ${spanId}`);
    }

    process.stdout.write(renderSpanDetail(matchedSpan));
    return;
  }

  process.stdout.write(isEnabledFlag(options.spans) ? renderSpanList(trace) : renderTraceSummary(trace));
}

async function writeGeneratedSingleFile(
  outputDirectory: string | undefined,
  fileName: string,
  content: string,
  kind: GenerateSubcommand
): Promise<void> {
  if (outputDirectory === undefined) {
    process.stdout.write(content);
    return;
  }

  const outputPath = join(outputDirectory, fileName);
  await writeTextOutput(outputPath, content);
  console.log(pc.green(`Generated ${kind} to ${outputPath}`));
}

async function writeGeneratedFileMap(
  outputDirectory: string | undefined,
  files: ReadonlyMap<string, string>
): Promise<void> {
  if (outputDirectory === undefined) {
    process.stdout.write(`${JSON.stringify(Object.fromEntries(files), null, 2)}\n`);
    return;
  }

  await mkdir(outputDirectory, { recursive: true });
  for (const [relativePath, content] of files) {
    await writeTextOutput(join(outputDirectory, relativePath), content);
  }

  console.log(pc.green(`Generated fixtures to ${outputDirectory}`));
}

async function runGenerateCommand(
  cwd: string,
  rawKind: string | undefined,
  tracePath: string | undefined,
  options: GenerateCommandOptions
): Promise<void> {
  const kind = parseGenerateSubcommand(rawKind);
  if (tracePath === undefined) {
    throw new CliError('Usage: ghost generate <mocks|fixtures|tests> <trace> [--framework name] [--output dir]');
  }

  const config = await loadConfig(cwd);
  const framework = parseGenerateFramework(kind, options.framework, config);
  const outputDirectory = outputDirectoryFromOptions(cwd, config, options.output);
  const trace = await loadValidatedTrace(resolve(cwd, tracePath), 'generate');

  if (kind === 'mocks') {
    await writeGeneratedSingleFile(
      outputDirectory,
      'mocks.ts',
      generateMocks(trace, { format: mockFormatFromFramework(framework) }),
      kind
    );
    return;
  }

  if (kind === 'fixtures') {
    await writeGeneratedFileMap(
      outputDirectory,
      generateFixtures(trace, { format: framework as FixtureGenerationFormat })
    );
    return;
  }

  await writeGeneratedSingleFile(
    outputDirectory,
    `${generatedFileBaseName(trace)}.test.ts`,
    generateTests(trace, { framework: framework as TestGenerationFramework }),
    kind
  );
}

if (isDirectExecution()) {
  void runCli(process.argv).then((exitCode: number): void => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
