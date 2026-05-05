import { TraceVersionError } from '../core/errors.js';
import { TRACE_FORMAT_VERSION, type Span, type Trace } from '../core/types.js';
import { withTraceChecksum } from './checksum.js';

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_SEQUENCE = ['1.0.0', '2.0.0', TRACE_FORMAT_VERSION] as const;
const SUPPORTED_VERSION_SET: ReadonlySet<string> = new Set(VERSION_SEQUENCE);

function parseVersion(version: string): ParsedVersion | undefined {
  const match = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u.exec(version);
  if (match?.groups === undefined) {
    return undefined;
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch)
  };
}

function compareVersions(left: string, right: string): number | undefined {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (leftVersion === undefined || rightVersion === undefined) {
    return undefined;
  }

  return (
    leftVersion.major - rightVersion.major ||
    leftVersion.minor - rightVersion.minor ||
    leftVersion.patch - rightVersion.patch
  );
}

function versionError(version: string): TraceVersionError {
  return new TraceVersionError(
    `Unsupported GhostTrace format version "${version}". This library supports up to ${TRACE_FORMAT_VERSION}; upgrade ghosttrace to read newer trace files.`,
    {
      code: 'TRACE_VERSION_UNSUPPORTED',
      context: {
        version,
        supportedVersion: TRACE_FORMAT_VERSION
      }
    }
  );
}

function migrateV1ToV2<TSpan extends Span>(trace: Trace<TSpan>): Trace<TSpan> {
  return {
    ...trace,
    version: '2.0.0'
  };
}

function migrateV2ToV3<TSpan extends Span>(trace: Trace<TSpan>): Trace<TSpan> {
  return withTraceChecksum({
    ...trace,
    version: TRACE_FORMAT_VERSION
  });
}

/** Returns true when GhostTrace knows how to read a trace format version. */
export function isSupportedTraceVersion(version: string): boolean {
  return SUPPORTED_VERSION_SET.has(version);
}

/** Throws TraceVersionError when a trace version is not readable by this library. */
export function assertSupportedTraceVersion(version: string): void {
  if (isSupportedTraceVersion(version)) {
    return;
  }

  const comparison = compareVersions(version, TRACE_FORMAT_VERSION);
  if (comparison === undefined || comparison > 0) {
    throw versionError(version);
  }

  throw versionError(version);
}

/** Migrates a trace through each intermediate GhostTrace format version to the current format. */
export function migrateTraceVersion<TSpan extends Span>(trace: Trace<TSpan>): Trace<TSpan> {
  assertSupportedTraceVersion(trace.version);

  switch (trace.version) {
    case TRACE_FORMAT_VERSION:
      return trace;
    case '1.0.0':
      return migrateV2ToV3(migrateV1ToV2(trace));
    case '2.0.0':
      return migrateV2ToV3(trace);
    default:
      throw versionError(trace.version);
  }
}
