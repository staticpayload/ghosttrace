import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RedactionError,
  SpanType,
  defineConfig,
  ghost,
  redactValue,
  wrapDb,
  wrapQueue,
  type DbAdapter,
  type QueueAdapter,
  type Span
} from '../../src/index.js';

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected record');
  }

  return value as Readonly<Record<string, unknown>>;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => asRecord(current)[key], value);
}

function spansOfType(spans: readonly Span[], type: SpanType): readonly Span[] {
  return spans.filter((span) => span.type === type);
}

interface RedactionDbClient {
  readonly query: (query: string, params?: readonly unknown[]) => Promise<{
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly rowCount: number;
  }>;
}

interface RedactionQueueClient {
  readonly send: (queueName: string, payload: unknown) => Promise<{ readonly id: string }>;
}

function createRedactionDbAdapter(): DbAdapter<RedactionDbClient> {
  return {
    name: 'redaction-db',
    operations: [
      {
        method: 'query',
        query: (args) => args[0],
        params: (args) => args[1],
        result: (result) =>
          typeof result === 'object' && result !== null && 'rows' in result ? result.rows : undefined,
        rowCount: (result) =>
          typeof result === 'object' && result !== null && 'rowCount' in result && typeof result.rowCount === 'number'
            ? result.rowCount
            : undefined
      }
    ]
  };
}

function createRedactionQueueAdapter(): QueueAdapter<RedactionQueueClient> {
  return {
    name: 'redaction-queue',
    operations: [
      {
        method: 'send',
        operation: 'send',
        queueName: (args) => (typeof args[0] === 'string' ? args[0] : undefined),
        payload: (args) => args[1],
        messageId: (_args, result) =>
          typeof result === 'object' && result !== null && 'id' in result && typeof result.id === 'string'
            ? result.id
            : undefined
      }
    ]
  };
}

const jwt = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  'signatureSegmentForJwtValue123'
].join('.');
const apiKey = ['sk', '-', '1234567890abcdef1234567890abcdef'].join('');
const githubToken = ['ghp_', 'abcdefghijklmnopqrstuvwxyz123456'].join('');
const connectionString = ['postgres://alice', ':secret@', 'example.com:5432/app'].join('');

describe('redaction engine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts all built-in sensitive value patterns with stable labels', () => {
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
      '-----END PRIVATE KEY-----'
    ].join('\n');
    const redacted = asRecord(
      redactValue({
        jwt,
        apiKey,
        awsKey: 'AKIAIOSFODNN7EXAMPLE',
        bearerToken: 'Bearer mF_9.B5f-4.1JqM',
        email: 'alice@example.com',
        creditCards: ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111'],
        connectionString,
        privateKey
      })
    );

    expect(redacted.jwt).toBe('[REDACTED:JWT]');
    expect(redacted.apiKey).toBe('[REDACTED:API_KEY]');
    expect(redacted.awsKey).toBe('[REDACTED:AWS_KEY]');
    expect(redacted.bearerToken).toBe('[REDACTED:BEARER_TOKEN]');
    expect(redacted.email).toBe('[REDACTED:EMAIL]');
    expect(redacted.creditCards).toEqual([
      '[REDACTED:CREDIT_CARD]',
      '[REDACTED:CREDIT_CARD]',
      '[REDACTED:CREDIT_CARD]'
    ]);
    expect(redacted.connectionString).toBe('[REDACTED:CONNECTION_STRING]');
    expect(redacted.privateKey).toBe('[REDACTED:PRIVATE_KEY]');
  });

  it('applies path rules with array wildcards and deep object paths only at matching locations', () => {
    const redacted = asRecord(
      redactValue(
        {
          users: [
            { ssn: '111-22-3333', note: '111-22-3333' },
            { ssn: '222-33-4444', note: '222-33-4444' }
          ],
          audit: { ssn: '333-44-5555' },
          a: { b: { c: { d: { e: { secret: 'deep-secret-value' } } } } }
        },
        {
          builtinPatterns: false,
          paths: [
            { path: '$.users[*].ssn', label: 'SSN' },
            { path: '$.a.b.c.d.e.secret', label: 'DEEP_SECRET' },
            { path: '$.missing[*].secret', label: 'MISSING' }
          ]
        }
      )
    );

    expect(redacted.users).toEqual([
      { ssn: '[REDACTED:SSN]', note: '111-22-3333' },
      { ssn: '[REDACTED:SSN]', note: '222-33-4444' }
    ]);
    expect(redacted.audit).toEqual({ ssn: '333-44-5555' });
    expect(redacted.a).toEqual({ b: { c: { d: { e: { secret: '[REDACTED:DEEP_SECRET]' } } } } });
  });

  it('applies custom regex rules with user-specified labels', () => {
    const redacted = asRecord(
      redactValue(
        {
          token: githubToken,
          message: `deploy with ${githubToken} now`
        },
        {
          builtinPatterns: false,
          regexRules: [{ pattern: /ghp_[A-Za-z0-9_]{20,}/u, label: 'GITHUB_TOKEN' }]
        }
      )
    );

    expect(redacted.token).toBe('[REDACTED:GITHUB_TOKEN]');
    expect(redacted.message).toBe('deploy with [REDACTED:GITHUB_TOKEN] now');
  });

  it('redacts irreversibly before trace data is written to disk', async () => {
    const writeFileSpy = vi.spyOn(fsPromises, 'writeFile').mockResolvedValue(undefined);
    const trace = await ghost.record(
      'redaction-save',
      () => ({
        email: 'alice@example.com',
        users: [{ ssn: '123-45-6789' }],
        apiKey
      }),
      {
        interceptors: [],
        redaction: {
          paths: [{ path: '$.users[*].ssn', label: 'SSN' }]
        }
      }
    );

    const transientTraceJson = JSON.stringify(trace);
    expect(transientTraceJson).not.toContain('alice@example.com');
    expect(transientTraceJson).not.toContain('123-45-6789');
    expect(transientTraceJson).not.toContain(apiKey);

    await trace.save(join('/tmp', 'redaction-save.ghosttrace.json'));

    const serializedWrite = String(writeFileSpy.mock.calls[0]?.[1]);
    expect(serializedWrite).not.toContain('alice@example.com');
    expect(serializedWrite).not.toContain('123-45-6789');
    expect(serializedWrite).not.toContain(apiKey);
    expect(serializedWrite).toContain('[REDACTED:EMAIL]');
    expect(serializedWrite).toContain('[REDACTED:SSN]');
    expect(serializedWrite).toContain('[REDACTED:API_KEY]');

    writeFileSpy.mockRestore();
  });

  it('uses field-name heuristics for long string secrets without redacting short or non-string values', () => {
    const redacted = asRecord(
      redactValue(
        {
          password: 'long-secret-value',
          shortPassword: 'short',
          clientSecret: 12345,
          sessionToken: '123456789',
          key: 'exact-key-secret',
          apiKey: 'abc123456',
          authorizationHeader: 'Basic abcdefghi'
        },
        { builtinPatterns: false }
      )
    );

    expect(redacted.password).toBe('[REDACTED:FIELD]');
    expect(redacted.shortPassword).toBe('short');
    expect(redacted.clientSecret).toBe(12345);
    expect(redacted.sessionToken).toBe('[REDACTED:FIELD]');
    expect(redacted.key).toBe('[REDACTED:FIELD]');
    expect(redacted.apiKey).toBe('[REDACTED:FIELD]');
    expect(redacted.authorizationHeader).toBe('[REDACTED:FIELD]');
  });

  it('handles circular objects without overflowing the redaction traversal stack', () => {
    const circular: Record<string, unknown> = {
      password: 'long-secret-value'
    };
    circular.self = circular;

    const redacted = asRecord(redactValue(circular, { builtinPatterns: false }));

    expect(redacted.password).toBe('[REDACTED:FIELD]');
  });

  it('traverses 10+ nested levels and arrays while preserving structure and normal descriptions', () => {
    const nestedKeys = Array.from({ length: 11 }, (_value, index) => `level${index}`);
    let nested: Record<string, unknown> = {
      secretToken: 'nested-secret-value'
    };

    for (let index = nestedKeys.length - 1; index >= 0; index -= 1) {
      const key = nestedKeys[index];
      if (key === undefined) {
        throw new Error('expected nested key');
      }
      nested = { [key]: nested };
    }

    const redacted = asRecord(
      redactValue(
        {
          nested,
          items: [
            { authKey: 'array-secret-value' },
            { description: 'token-bucket-algorithm' },
            ['plain', { password: 'another-secret-value' }]
          ]
        },
        { builtinPatterns: false }
      )
    );
    const redactedNested = asRecord(valueAtPath(redacted.nested, nestedKeys));

    expect(Array.isArray(redacted.items)).toBe(true);
    expect(redactedNested.secretToken).toBe('[REDACTED:FIELD]');
    expect(redacted.items).toEqual([
      { authKey: '[REDACTED:FIELD]' },
      { description: 'token-bucket-algorithm' },
      ['plain', { password: '[REDACTED:FIELD]' }]
    ]);
  });

  it('uses first matching pattern once and remains idempotent on repeated redaction', () => {
    const bearerJwt = `Bearer ${jwt}`;
    const once = asRecord(redactValue({ authorization: bearerJwt }));
    const twice = asRecord(redactValue(once));

    expect(once.authorization).toBe('[REDACTED:BEARER_TOKEN]');
    expect(twice.authorization).toBe('[REDACTED:BEARER_TOKEN]');
  });

  it('can selectively or fully disable built-in patterns without disabling custom rules', () => {
    const jwtDisabled = asRecord(
      redactValue(
        {
          jwt,
          email: 'alice@example.com'
        },
        {
          builtinPatterns: { jwt: false }
        }
      )
    );
    const allBuiltinsDisabled = asRecord(
      redactValue(
        {
          jwt,
          email: 'alice@example.com',
          custom: githubToken
        },
        {
          builtinPatterns: false,
          regexRules: [{ pattern: /ghp_[A-Za-z0-9_]{20,}/u, label: 'GITHUB_TOKEN' }]
        }
      )
    );

    expect(jwtDisabled.jwt).toBe(jwt);
    expect(jwtDisabled.email).toBe('[REDACTED:EMAIL]');
    expect(allBuiltinsDisabled.jwt).toBe(jwt);
    expect(allBuiltinsDisabled.email).toBe('alice@example.com');
    expect(allBuiltinsDisabled.custom).toBe('[REDACTED:GITHUB_TOKEN]');
  });

  it('redacts secrets captured by HTTP, FS, DB, Env, and Queue interceptors', async () => {
    const tempFile = join(tmpdir(), `ghosttrace-redaction-${process.pid}-${Date.now()}.txt`);
    const envKey = 'GHOSTTRACE_REDACTION_API_TOKEN';
    const originalEnvValue = process.env[envKey];
    const httpResponseSecret = 'alice@example.com';
    const envSecret = `Bearer ${jwt}`;
    const dbSecret = apiKey;
    const queueSecret = 'bob@example.com';
    const fileSecret = connectionString;

    await fsPromises.writeFile(tempFile, `stored ${fileSecret}`, 'utf8');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ contact: httpResponseSecret }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const dbClient: RedactionDbClient = {
      async query(
        _query: string,
        _params: readonly unknown[] = []
      ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[]; readonly rowCount: number }> {
        return {
          rows: [{ apiKey: dbSecret }],
          rowCount: 1
        };
      }
    };
    const db = wrapDb(dbClient, createRedactionDbAdapter());
    const queue = wrapQueue(
      {
        async send(_queueName: string, _payload: unknown): Promise<{ readonly id: string }> {
          return { id: 'msg-redaction' };
        }
      },
      createRedactionQueueAdapter()
    );

    try {
      const trace = await ghost.record(
        'cross-interceptor-redaction',
        async () => {
          const response = await fetch('https://example.com/secrets', {
            method: 'POST',
            headers: { authorization: envSecret },
            body: JSON.stringify({ apiKey: dbSecret })
          });
          await response.text();
          await fsPromises.readFile(tempFile, 'utf8');
          await db.query('SELECT * FROM secrets WHERE id = ?', [1]);
          process.env[envKey] = envSecret;
          await queue.send('jobs', { email: queueSecret });
        },
        {
          interceptors: ['http', 'fs', 'db', 'env', 'queue']
        }
      );
      const traceJson = JSON.stringify(trace);

      expect(traceJson).not.toContain(httpResponseSecret);
      expect(traceJson).not.toContain(fileSecret);
      expect(traceJson).not.toContain(dbSecret);
      expect(traceJson).not.toContain(envSecret);
      expect(traceJson).not.toContain(queueSecret);
      expect(JSON.stringify(spansOfType(trace.spans, SpanType.Http))).toContain('[REDACTED:EMAIL]');
      expect(JSON.stringify(spansOfType(trace.spans, SpanType.Fs))).toContain('[REDACTED:CONNECTION_STRING]');
      expect(JSON.stringify(spansOfType(trace.spans, SpanType.Db))).toContain('[REDACTED:API_KEY]');
      expect(JSON.stringify(spansOfType(trace.spans, SpanType.Env))).toContain('[REDACTED:BEARER_TOKEN]');
      expect(JSON.stringify(spansOfType(trace.spans, SpanType.Queue))).toContain('[REDACTED:EMAIL]');
    } finally {
      if (originalEnvValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalEnvValue;
      }
      await fsPromises.unlink(tempFile).catch(() => undefined);
    }
  });

  it('redacts env span values with sensitive-key heuristics even without built-in pattern matches', async () => {
    const envKey = 'GHOSTTRACE_REDACTION_PASSWORD';
    const originalEnvValue = process.env[envKey];
    const envSecret = 'plain-env-secret-value';

    process.env[envKey] = envSecret;

    try {
      const trace = await ghost.record(
        'env-heuristic-redaction',
        () => {
          void process.env[envKey];
          return 'done';
        },
        {
          interceptors: ['env'],
          redaction: {
            builtinPatterns: false
          }
        }
      );
      const [envSpan] = spansOfType(trace.spans, SpanType.Env);

      expect(envSpan).toBeDefined();
      expect(JSON.stringify(envSpan)).not.toContain(envSecret);
      expect(JSON.stringify(envSpan)).toContain('[REDACTED:FIELD]');
      expect(envSpan?.metadata.key).toBe(envKey);
    } finally {
      if (originalEnvValue === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = originalEnvValue;
      }
    }
  });

  it('validates malformed regex and path rules before record functions execute', async () => {
    const fn = vi.fn(() => 'should not run');

    expect(() =>
      defineConfig({
        redaction: {
          regexRules: [{ pattern: '[unterminated', label: 'BROKEN' }]
        }
      })
    ).toThrow(RedactionError);
    await expect(
      ghost.record('invalid-redaction-config', fn, {
        redaction: {
          pathRules: [{ path: '$.users[', label: 'BROKEN_PATH' }]
        }
      })
    ).rejects.toThrow(RedactionError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('redacts 1000 entries within 500ms', () => {
    const entries = Array.from({ length: 1000 }, (_value, index) => ({
      password: `very-long-password-${index}`,
      apiKey: `custom-key-value-${index}`,
      description: 'token-bucket-algorithm'
    }));
    const startedAt = performance.now();
    const redacted = redactValue(entries, { builtinPatterns: false });
    const durationMs = performance.now() - startedAt;

    expect(durationMs).toBeLessThan(500);
    expect(redacted.every((entry) => entry.password === '[REDACTED:FIELD]')).toBe(true);
    expect(redacted.every((entry) => entry.apiKey === '[REDACTED:FIELD]')).toBe(true);
    expect(redacted.every((entry) => entry.description === 'token-bucket-algorithm')).toBe(true);
  });
});
