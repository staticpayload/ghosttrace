import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ghost, redactValue } from '../../src/index.js';

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected record');
  }

  return value as Readonly<Record<string, unknown>>;
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
});
