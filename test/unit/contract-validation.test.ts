import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SpanType,
  TRACE_FORMAT_VERSION,
  TraceVersionError,
  computeTraceChecksum,
  ghost,
  migrateTraceVersion,
  withTraceChecksum,
  type Span,
  type Trace
} from '../../src/index.js';

const tempDirs: string[] = [];

function span(id: string, fields: Partial<Span> = {}): Span {
  return {
    id,
    parentId: null,
    type: SpanType.Function,
    name: `operation-${id}`,
    startTime: 0,
    endTime: 1,
    duration: 1,
    input: [],
    output: { ok: true },
    children: [],
    error: null,
    metadata: {},
    ...fields
  };
}

function trace(spans: readonly Span[] = [span('span_0001')], fields: Partial<Trace> = {}): Trace {
  return {
    id: 'trace_contract_validation',
    name: 'contract-validation',
    version: TRACE_FORMAT_VERSION,
    startTime: 0,
    endTime: Math.max(1, spans.at(-1)?.endTime ?? 1),
    duration: Math.max(1, spans.at(-1)?.endTime ?? 1),
    spans,
    metadata: {},
    ...fields
  };
}

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ghosttrace-validation-'));
  tempDirs.push(directory);
  return directory;
}

describe('contract validation and versioning', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('accumulates schema validation errors for required fields, ordering, and parent references while warning on unknown span types', () => {
    const first = span('span_0001', {
      type: 'custom-side-effect' as SpanType,
      startTime: 5,
      endTime: 6,
      duration: 1
    });
    const second = span('span_0002', {
      parentId: 'span_missing',
      startTime: 4,
      endTime: 7,
      duration: 3
    });
    const invalidSpan = { ...second } as Record<string, unknown>;
    delete invalidSpan.name;
    delete invalidSpan.input;
    delete invalidSpan.output;
    const invalidTrace = withTraceChecksum(
      trace([first, invalidSpan as unknown as Span], { name: undefined as unknown as string })
    );

    const result = ghost.validateTrace(invalidTrace);

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'TRACE_REQUIRED_FIELD_MISSING',
        'TRACE_SPAN_SEQUENCE_NON_MONOTONIC',
        'TRACE_PARENT_ID_DANGLING'
      ])
    );
    expect(result.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining([
        '$.name',
        '$.spans[1].name',
        '$.spans[1].input',
        '$.spans[1].output',
        '$.spans[1].parentId'
      ])
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'TRACE_SPAN_TYPE_UNKNOWN',
        path: '$.spans[0].type',
        severity: 'warning'
      })
    ]);
  });

  it('computes SHA-256 checksums over canonical JSON independent of key order and detects tampering', () => {
    const checked = withTraceChecksum(trace());
    const sameTraceDifferentKeyOrder = {
      metadata: checked.metadata,
      spans: checked.spans,
      duration: checked.duration,
      endTime: checked.endTime,
      startTime: checked.startTime,
      version: checked.version,
      name: checked.name,
      id: checked.id
    } as Trace;

    expect(checked.checksum).toBe(`sha256:${computeTraceChecksum(sameTraceDifferentKeyOrder)}`);
    expect(ghost.validateTrace(checked)).toMatchObject({ valid: true, errors: [] });

    const tampered = {
      ...checked,
      spans: [span('span_0001', { output: { ok: false } })]
    };
    const tamperedResult = ghost.validateTrace(tampered);

    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.errors).toEqual([
      expect.objectContaining({
        code: 'TRACE_CHECKSUM_MISMATCH',
        path: '$.checksum'
      })
    ]);
  });

  it('requires checksums for current-format traces while still accepting migrated older traces without checksums', () => {
    const currentWithoutChecksum = trace();

    const currentResult = ghost.validateTrace(currentWithoutChecksum);

    expect(currentResult.valid).toBe(false);
    expect(currentResult.errors).toEqual([
      expect.objectContaining({
        code: 'TRACE_CHECKSUM_MISSING',
        path: '$.checksum'
      })
    ]);

    const checkedBaseline = withTraceChecksum(trace([span('span_0001')]));
    expect(() => ghost.diff(checkedBaseline, currentWithoutChecksum)).toThrow(/current trace is invalid/i);
    expect(() => ghost.diff(checkedBaseline, currentWithoutChecksum)).toThrow(/checksum/i);

    const migratedResult = ghost.validateTrace(trace([span('span_0001')], { version: '1.0.0' }));
    expect(migratedResult).toMatchObject({ valid: true, errors: [] });
    expect(migratedResult.trace).toMatchObject({
      version: TRACE_FORMAT_VERSION,
      checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
  });

  it('migrates v1 traces through v2 to the current format idempotently while preserving span order', () => {
    const v1 = trace([span('span_0001'), span('span_0002')], { version: '1.0.0' });

    const migrated = migrateTraceVersion(v1);

    expect(migrated.version).toBe(TRACE_FORMAT_VERSION);
    expect(migrated.spans.map((migratedSpan) => migratedSpan.id)).toEqual(['span_0001', 'span_0002']);
    expect(migrated.spans).toHaveLength(v1.spans.length);
    expect(migrated.checksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(migrateTraceVersion(migrated)).toEqual(migrated);
  });

  it('validates and migrates object, path, and mixed ghost.diff inputs before diffing', async () => {
    const directory = await createTempDir();
    const baseline = withTraceChecksum(trace([span('span_0001')], { version: '1.0.0' }));
    const current = withTraceChecksum(
      trace([span('span_0001', { output: { ok: false } })], { version: TRACE_FORMAT_VERSION })
    );
    const baselinePath = join(directory, 'baseline.ghosttrace.json');
    await writeFile(baselinePath, JSON.stringify(baseline), 'utf8');

    const result = await ghost.diff(baselinePath, current);

    expect(result.status).toBe('drift');
    expect(result.changes).toEqual([
      expect.objectContaining({
        type: 'changed',
        field: 'output.ok',
        baseline: true,
        current: false
      })
    ]);

    const invalidBaseline = withTraceChecksum(
      trace([span('span_0001', { parentId: 'missing_parent' })], { version: TRACE_FORMAT_VERSION })
    );

    expect(() => ghost.diff(invalidBaseline, current)).toThrow(/baseline/i);
  });

  it('ghost.validateTrace accepts valid objects, invalid objects, valid files, missing files, and malformed JSON files', async () => {
    const directory = await createTempDir();
    const validTrace = withTraceChecksum(trace());
    const validPath = join(directory, 'valid.ghosttrace.json');
    const malformedPath = join(directory, 'malformed.ghosttrace.json');
    await writeFile(validPath, JSON.stringify(validTrace), 'utf8');
    await writeFile(malformedPath, '{ not-json', 'utf8');

    expect(ghost.validateTrace(validTrace)).toMatchObject({ valid: true, errors: [] });

    const invalidObjectResult = ghost.validateTrace(withTraceChecksum({ ...validTrace, spans: 'not-spans' } as unknown as Trace));
    expect(invalidObjectResult.valid).toBe(false);
    expect(invalidObjectResult.errors).toEqual([
      expect.objectContaining({
        code: 'TRACE_FIELD_TYPE_INVALID',
        path: '$.spans'
      })
    ]);

    await expect(ghost.validateTrace(validPath)).resolves.toMatchObject({ valid: true, errors: [] });
    await expect(ghost.validateTrace(join(directory, 'missing.ghosttrace.json'))).resolves.toMatchObject({
      valid: false,
      errors: [expect.objectContaining({ code: 'TRACE_FILE_NOT_FOUND' })]
    });
    await expect(ghost.validateTrace(malformedPath)).resolves.toMatchObject({
      valid: false,
      errors: [expect.objectContaining({ code: 'TRACE_JSON_PARSE_ERROR' })]
    });

    expect(await readFile(validPath, 'utf8')).toContain('"checksum"');
  });

  it('throws TraceVersionError for unsupported future trace format versions', () => {
    expect(() => ghost.validateTrace(trace([], { version: '99.0.0' }))).toThrow(TraceVersionError);
    expect(() => migrateTraceVersion(trace([], { version: '99.0.0' }))).toThrow(/upgrade/i);
  });
});
