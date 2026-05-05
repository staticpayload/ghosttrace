import { createHash } from 'node:crypto';
import type { Span, Trace } from '../core/types.js';
import { canonicalJsonStringify, toSerializableTrace } from './canonical.js';

const CHECKSUM_PREFIX = 'sha256:';
const SHA256_HEX = /^[a-f0-9]{64}$/u;

/** Trace with a top-level SHA-256 integrity checksum. */
export type ChecksummedTrace<TSpan extends Span = Span> = Trace<TSpan> & {
  readonly checksum: string;
};

/** Computes a SHA-256 digest over canonical trace JSON, excluding the checksum field itself. */
export function computeTraceChecksum(trace: Trace): string {
  return createHash('sha256')
    .update(canonicalJsonStringify(toSerializableTrace(trace), { omitTopLevelChecksum: true }), 'utf8')
    .digest('hex');
}

/** Formats a raw SHA-256 hex digest for storage in trace JSON. */
export function formatTraceChecksum(checksum: string): string {
  return checksum.startsWith(CHECKSUM_PREFIX) ? checksum : `${CHECKSUM_PREFIX}${checksum}`;
}

/** Returns true when a value has the checksum storage format emitted by GhostTrace. */
export function isFormattedTraceChecksum(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(CHECKSUM_PREFIX) && SHA256_HEX.test(value.slice(CHECKSUM_PREFIX.length));
}

/** Returns a trace copy with a canonical SHA-256 checksum attached. */
export function withTraceChecksum<TSpan extends Span, TTrace extends Trace<TSpan>>(trace: TTrace): TTrace & ChecksummedTrace<TSpan> {
  return {
    ...trace,
    checksum: formatTraceChecksum(computeTraceChecksum(trace))
  } as TTrace & ChecksummedTrace<TSpan>;
}

/** Verifies a trace's stored checksum against its canonical JSON digest. */
export function verifyTraceChecksum(trace: Trace): boolean {
  if (!isFormattedTraceChecksum(trace.checksum)) {
    return false;
  }

  return trace.checksum === formatTraceChecksum(computeTraceChecksum(trace));
}
