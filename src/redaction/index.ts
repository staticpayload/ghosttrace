import { RedactionError } from '../core/errors.js';
import { SpanType, type Span, type Trace, type TraceMetadata } from '../core/types.js';

/** Built-in secret pattern identifiers that can be toggled individually. */
export type BuiltinRedactionPatternName =
  | 'jwt'
  | 'apiKey'
  | 'awsKey'
  | 'bearerToken'
  | 'email'
  | 'creditCard'
  | 'connectionString'
  | 'privateKey';

/** Built-in redaction pattern toggles. `false` disables all built-ins. */
export type BuiltinRedactionPatternConfig = boolean | Partial<Record<BuiltinRedactionPatternName, boolean>>;

/** Path-based redaction rule using JSONPath-like property, index, and wildcard segments. */
export interface RedactionPathRule {
  /** Rooted path expression, for example `$.users[*].ssn`. */
  readonly path: string;
  /** Placeholder label. Defaults to `PATH`. */
  readonly label?: string;
}

/** Regex-based redaction rule with a user-controlled placeholder label. */
export interface RedactionRegexRule {
  /** Regular expression or source string to match inside string values. */
  readonly pattern: RegExp | string;
  /** Placeholder label used in `[REDACTED:{label}]`. */
  readonly label: string;
}

/** Secret redaction settings for values, traces, and recording sessions. */
export interface RedactionOptions {
  /** Set to false to disable all redaction, including custom rules. */
  readonly enabled?: boolean;
  /** Built-in pattern toggles. Defaults to all built-ins enabled. */
  readonly builtinPatterns?: BuiltinRedactionPatternConfig;
  /** User path rules; alias of pathRules for concise config files. */
  readonly paths?: readonly RedactionPathRule[];
  /** User path rules; alias of paths for explicit config files. */
  readonly pathRules?: readonly RedactionPathRule[];
  /** User regex rules; alias of patterns for explicit config files. */
  readonly regexRules?: readonly RedactionRegexRule[];
  /** User regex rules; alias of regexRules for concise config files. */
  readonly patterns?: readonly RedactionRegexRule[];
}

type PathComponent = string | number;

interface PropertyPathSegment {
  readonly kind: 'property';
  readonly key: string;
}

interface IndexPathSegment {
  readonly kind: 'index';
  readonly index: number;
}

interface WildcardPathSegment {
  readonly kind: 'wildcard';
}

type PathSegment = PropertyPathSegment | IndexPathSegment | WildcardPathSegment;

interface CompiledPathRule {
  readonly path: string;
  readonly label: string;
  readonly segments: readonly PathSegment[];
}

interface CompiledRegexRule {
  readonly label: string;
  readonly regex: RegExp;
}

interface TextRedactionPattern {
  readonly name: BuiltinRedactionPatternName;
  readonly label: string;
  readonly redact: (value: string) => string;
}

interface CompiledRedactionOptions {
  readonly enabled: boolean;
  readonly builtinPatterns: readonly TextRedactionPattern[];
  readonly pathRules: readonly CompiledPathRule[];
  readonly regexRules: readonly CompiledRegexRule[];
}

interface RegexBuiltinDefinition {
  readonly name: BuiltinRedactionPatternName;
  readonly label: string;
  readonly regex: RegExp;
}

const REDACTED_PLACEHOLDER_PATTERN = /^\[REDACTED:[^\]]+\]$/u;
const CREDIT_CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){13,19}(?![\d-])/gu;
const SENSITIVE_FIELD_NAME_PATTERN = /(?:password|secret|token|key|auth)/iu;
const FIELD_HEURISTIC_MIN_LENGTH = 8;
const PATH_TOKEN = '$';

const REGEX_BUILTIN_DEFINITIONS = [
  {
    name: 'privateKey',
    label: 'PRIVATE_KEY',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu
  },
  {
    name: 'connectionString',
    label: 'CONNECTION_STRING',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s"'<>]+/giu
  },
  {
    name: 'bearerToken',
    label: 'BEARER_TOKEN',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gu
  },
  {
    name: 'jwt',
    label: 'JWT',
    regex: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu
  },
  {
    name: 'awsKey',
    label: 'AWS_KEY',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu
  },
  {
    name: 'apiKey',
    label: 'API_KEY',
    regex: /\b(?:(?:sk|rk)-[A-Za-z0-9]{20,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35})\b/gu
  },
  {
    name: 'email',
    label: 'EMAIL',
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu
  }
] as const satisfies readonly RegexBuiltinDefinition[];

/** Returns the canonical placeholder emitted for a redaction label. */
export function redactionPlaceholder(label: string): string {
  return `[REDACTED:${label}]`;
}

function isRedactedPlaceholder(value: string): boolean {
  return REDACTED_PLACEHOLDER_PATTERN.test(value);
}

function normalizeLabel(label: string | undefined, fallback: string): string {
  const normalized = (label ?? fallback).trim();

  if (normalized.length === 0) {
    throw new RedactionError('Redaction rule label must not be empty', {
      code: 'GHOSTTRACE_REDACTION_INVALID_LABEL'
    });
  }

  return normalized;
}

function cloneGlobalRegex(regex: RegExp): RegExp {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return new RegExp(regex.source, flags);
}

function replaceMatches(
  value: string,
  regex: RegExp,
  label: string,
  shouldReplace: (match: string) => boolean = () => true
): string {
  regex.lastIndex = 0;
  const replaced = value.replace(regex, (match: string) =>
    shouldReplace(match) ? redactionPlaceholder(label) : match
  );
  regex.lastIndex = 0;

  return replaced;
}

function digitsOnly(value: string): string {
  return value.replace(/[ -]/gu, '');
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number.parseInt(digits.charAt(index), 10);

    if (!Number.isInteger(digit)) {
      return false;
    }

    if (shouldDouble) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }

    shouldDouble = !shouldDouble;
  }

  return sum > 0 && sum % 10 === 0;
}

function redactCreditCards(value: string): string {
  return replaceMatches(value, CREDIT_CARD_CANDIDATE, 'CREDIT_CARD', (match) => {
    const digits = digitsOnly(match);
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

function createRegexBuiltinPattern(definition: RegexBuiltinDefinition): TextRedactionPattern {
  return {
    name: definition.name,
    label: definition.label,
    redact: (value: string) => replaceMatches(value, cloneGlobalRegex(definition.regex), definition.label)
  };
}

function createCreditCardPattern(): TextRedactionPattern {
  return {
    name: 'creditCard',
    label: 'CREDIT_CARD',
    redact: redactCreditCards
  };
}

function builtinPatterns(): readonly TextRedactionPattern[] {
  return [
    ...REGEX_BUILTIN_DEFINITIONS.map(createRegexBuiltinPattern),
    createCreditCardPattern()
  ];
}

function builtinPatternEnabled(
  config: BuiltinRedactionPatternConfig | undefined,
  name: BuiltinRedactionPatternName
): boolean {
  if (config === false) {
    return false;
  }

  if (config === true || config === undefined) {
    return true;
  }

  return config[name] !== false;
}

function invalidPath(path: string, reason: string): RedactionError {
  return new RedactionError(`Invalid redaction path "${path}": ${reason}`, {
    code: 'GHOSTTRACE_REDACTION_INVALID_PATH',
    context: { path, reason }
  });
}

function parseBracketPathSegment(path: string, rawSegment: string): PathSegment {
  const raw = rawSegment.trim();

  if (raw === '*') {
    return { kind: 'wildcard' };
  }

  if (/^\d+$/u.test(raw)) {
    return { kind: 'index', index: Number.parseInt(raw, 10) };
  }

  const quotedWithDouble = raw.startsWith('"') && raw.endsWith('"');
  const quotedWithSingle = raw.startsWith("'") && raw.endsWith("'");
  if (raw.length >= 2 && (quotedWithDouble || quotedWithSingle)) {
    const key = raw.slice(1, -1);
    if (key.length === 0) {
      throw invalidPath(path, 'quoted property names must not be empty');
    }

    return { kind: 'property', key };
  }

  throw invalidPath(path, `unsupported bracket segment "${rawSegment}"`);
}

function parsePath(path: string): readonly PathSegment[] {
  if (!path.startsWith(PATH_TOKEN)) {
    throw invalidPath(path, 'path must start with $');
  }

  const segments: PathSegment[] = [];
  let index = PATH_TOKEN.length;

  while (index < path.length) {
    const char = path.charAt(index);

    if (char === '.') {
      const keyStart = index + 1;
      let keyEnd = keyStart;
      while (keyEnd < path.length && path.charAt(keyEnd) !== '.' && path.charAt(keyEnd) !== '[') {
        keyEnd += 1;
      }

      const key = path.slice(keyStart, keyEnd);
      if (key.length === 0) {
        throw invalidPath(path, 'property segment must not be empty');
      }

      segments.push({ kind: 'property', key });
      index = keyEnd;
      continue;
    }

    if (char === '[') {
      const closeIndex = path.indexOf(']', index + 1);
      if (closeIndex === -1) {
        throw invalidPath(path, 'missing closing ]');
      }

      segments.push(parseBracketPathSegment(path, path.slice(index + 1, closeIndex)));
      index = closeIndex + 1;
      continue;
    }

    throw invalidPath(path, `unexpected character "${char}"`);
  }

  return segments;
}

function compilePathRule(rule: RedactionPathRule): CompiledPathRule {
  if (typeof rule.path !== 'string' || rule.path.length === 0) {
    throw invalidPath(String(rule.path), 'path must be a non-empty string');
  }

  return {
    path: rule.path,
    label: normalizeLabel(rule.label, 'PATH'),
    segments: parsePath(rule.path)
  };
}

function compileRegexRule(rule: RedactionRegexRule): CompiledRegexRule {
  const label = normalizeLabel(rule.label, 'CUSTOM');

  try {
    return {
      label,
      regex: typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'gu') : cloneGlobalRegex(rule.pattern)
    };
  } catch (error) {
    throw new RedactionError(`Invalid redaction regex for label "${label}"`, {
      code: 'GHOSTTRACE_REDACTION_INVALID_REGEX',
      context: { label },
      cause: error
    });
  }
}

function compileRedactionOptions(options: RedactionOptions = {}): CompiledRedactionOptions {
  const builtinConfig = options.builtinPatterns;
  const allPathRules = [...(options.paths ?? []), ...(options.pathRules ?? [])];
  const allRegexRules = [...(options.regexRules ?? []), ...(options.patterns ?? [])];

  return {
    enabled: options.enabled !== false,
    builtinPatterns: builtinPatterns().filter((pattern) => builtinPatternEnabled(builtinConfig, pattern.name)),
    pathRules: allPathRules.map(compilePathRule),
    regexRules: allRegexRules.map(compileRegexRule)
  };
}

function cloneRedactionPathRule(rule: RedactionPathRule): RedactionPathRule {
  const cloned: { path: string; label?: string } = { path: rule.path };
  if (rule.label !== undefined) {
    cloned.label = rule.label;
  }

  return cloned;
}

function cloneRedactionRegexRule(rule: RedactionRegexRule): RedactionRegexRule {
  return {
    pattern: rule.pattern,
    label: rule.label
  };
}

/** Validates and clones redaction options for config normalization. */
export function normalizeRedactionOptions(options: RedactionOptions = {}): RedactionOptions {
  compileRedactionOptions(options);

  const normalized: {
    enabled?: boolean;
    builtinPatterns?: BuiltinRedactionPatternConfig;
    paths?: readonly RedactionPathRule[];
    pathRules?: readonly RedactionPathRule[];
    regexRules?: readonly RedactionRegexRule[];
    patterns?: readonly RedactionRegexRule[];
  } = {};

  if (options.enabled !== undefined) {
    normalized.enabled = options.enabled;
  }
  if (options.builtinPatterns !== undefined) {
    normalized.builtinPatterns =
      typeof options.builtinPatterns === 'boolean' ? options.builtinPatterns : { ...options.builtinPatterns };
  }
  if (options.paths !== undefined) {
    normalized.paths = options.paths.map(cloneRedactionPathRule);
  }
  if (options.pathRules !== undefined) {
    normalized.pathRules = options.pathRules.map(cloneRedactionPathRule);
  }
  if (options.regexRules !== undefined) {
    normalized.regexRules = options.regexRules.map(cloneRedactionRegexRule);
  }
  if (options.patterns !== undefined) {
    normalized.patterns = options.patterns.map(cloneRedactionRegexRule);
  }

  return normalized;
}

function pathSegmentMatches(ruleSegment: PathSegment, component: PathComponent): boolean {
  if (ruleSegment.kind === 'wildcard') {
    return true;
  }

  if (ruleSegment.kind === 'property') {
    return typeof component === 'string' && component === ruleSegment.key;
  }

  return typeof component === 'number' && component === ruleSegment.index;
}

function pathMatches(ruleSegments: readonly PathSegment[], path: readonly PathComponent[]): boolean {
  if (ruleSegments.length !== path.length) {
    return false;
  }

  return ruleSegments.every((segment, index) => {
    const component = path[index];
    return component !== undefined && pathSegmentMatches(segment, component);
  });
}

function matchingPathRule(pathRules: readonly CompiledPathRule[], path: readonly PathComponent[]): CompiledPathRule | undefined {
  return pathRules.find((rule) => pathMatches(rule.segments, path));
}

function redactString(value: string, options: CompiledRedactionOptions): string {
  if (isRedactedPlaceholder(value)) {
    return value;
  }

  let redacted = value;
  for (const pattern of options.builtinPatterns) {
    redacted = pattern.redact(redacted);
  }
  for (const rule of options.regexRules) {
    redacted = replaceMatches(redacted, rule.regex, rule.label);
  }

  return redacted;
}

function shouldRedactByFieldName(
  fieldName: string | undefined,
  value: string,
  allowExactKeyHeuristic: boolean
): boolean {
  const normalizedFieldName = fieldName?.toLowerCase();

  return (
    normalizedFieldName !== undefined &&
    (allowExactKeyHeuristic || normalizedFieldName !== 'key') &&
    value.length > FIELD_HEURISTIC_MIN_LENGTH &&
    !isRedactedPlaceholder(value) &&
    SENSITIVE_FIELD_NAME_PATTERN.test(normalizedFieldName)
  );
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactArray(
  value: readonly unknown[],
  options: CompiledRedactionOptions,
  path: readonly PathComponent[],
  allowExactKeyHeuristic: boolean
): unknown[] {
  const redacted = new Array<unknown>(value.length);

  for (let index = 0; index < value.length; index += 1) {
    if (Object.prototype.hasOwnProperty.call(value, index)) {
      redacted[index] = redactRecursive(value[index], options, [...path, index], undefined, allowExactKeyHeuristic);
    }
  }

  return redacted;
}

function redactPlainObject(
  value: Readonly<Record<string, unknown>>,
  options: CompiledRedactionOptions,
  path: readonly PathComponent[],
  allowExactKeyHeuristic: boolean
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const key of Object.keys(value)) {
    redacted[key] = redactRecursive(value[key], options, [...path, key], key, allowExactKeyHeuristic);
  }

  return redacted;
}

function redactMap(
  value: ReadonlyMap<unknown, unknown>,
  options: CompiledRedactionOptions,
  allowExactKeyHeuristic: boolean
): Map<unknown, unknown> {
  const redacted = new Map<unknown, unknown>();
  let index = 0;

  for (const [key, entryValue] of value.entries()) {
    redacted.set(
      redactRecursive(key, options, [index, 'key'], undefined, allowExactKeyHeuristic),
      redactRecursive(entryValue, options, [index, 'value'], undefined, allowExactKeyHeuristic)
    );
    index += 1;
  }

  return redacted;
}

function redactSet(
  value: ReadonlySet<unknown>,
  options: CompiledRedactionOptions,
  allowExactKeyHeuristic: boolean
): Set<unknown> {
  const redacted = new Set<unknown>();
  let index = 0;

  for (const item of value.values()) {
    redacted.add(redactRecursive(item, options, [index], undefined, allowExactKeyHeuristic));
    index += 1;
  }

  return redacted;
}

function redactRecursive(
  value: unknown,
  options: CompiledRedactionOptions,
  path: readonly PathComponent[],
  fieldName: string | undefined,
  allowExactKeyHeuristic: boolean
): unknown {
  if (!options.enabled) {
    return value;
  }

  const pathRule = matchingPathRule(options.pathRules, path);
  if (pathRule !== undefined) {
    return redactionPlaceholder(pathRule.label);
  }

  if (typeof value === 'string') {
    const patternRedacted = redactString(value, options);
    if (patternRedacted !== value) {
      return patternRedacted;
    }

    return shouldRedactByFieldName(fieldName, value, allowExactKeyHeuristic) ? redactionPlaceholder('FIELD') : value;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return redactArray(value, options, path, allowExactKeyHeuristic);
  }

  if (value instanceof Map) {
    return redactMap(value, options, allowExactKeyHeuristic);
  }

  if (value instanceof Set) {
    return redactSet(value, options, allowExactKeyHeuristic);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return redactPlainObject(value as Readonly<Record<string, unknown>>, options, path, allowExactKeyHeuristic);
}

function redactPayloadRoot<TValue>(value: TValue, options: CompiledRedactionOptions): TValue {
  return redactRecursive(value, options, [], undefined, true) as TValue;
}

function redactSpanPayloadRoot<TValue>(
  value: TValue,
  options: CompiledRedactionOptions,
  allowExactKeyHeuristic: boolean
): TValue {
  return redactRecursive(value, options, [], undefined, allowExactKeyHeuristic) as TValue;
}

function redactSpanPayloads<TSpan extends Span>(span: TSpan, options: CompiledRedactionOptions): TSpan {
  const allowExactKeyHeuristic = span.type !== SpanType.Env;

  return {
    ...span,
    input: redactSpanPayloadRoot(span.input, options, allowExactKeyHeuristic),
    output: redactSpanPayloadRoot(span.output, options, allowExactKeyHeuristic),
    children: span.children.map((child) => redactSpanPayloads(child, options)),
    metadata: redactSpanPayloadRoot(span.metadata, options, false) as TraceMetadata
  };
}

/** Redacts sensitive values from an arbitrary value without mutating the original input. */
export function redactValue<TValue>(value: TValue, options: RedactionOptions = {}): TValue {
  return redactPayloadRoot(value, compileRedactionOptions(options));
}

/** Redacts sensitive values from a trace before it can be persisted or replayed elsewhere. */
export function redactTrace<TSpan extends Span>(trace: Trace<TSpan>, options: RedactionOptions = {}): Trace<TSpan> {
  const compiled = compileRedactionOptions(options);

  return {
    ...trace,
    metadata: redactPayloadRoot(trace.metadata, compiled),
    spans: trace.spans.map((span) => redactSpanPayloads(span, compiled))
  };
}
