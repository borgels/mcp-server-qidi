import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  assertAuthorized,
  assertSafeHttpStartup,
  constantTimeEquals,
  forwardedHeadersTrusted,
} from '../src/transports/http-helpers.js';
import { checkToolPolicy } from '../src/qidi/policy.js';

function req(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

const base = { host: '127.0.0.1', port: 0, maxBodyBytes: 1024 };

describe('http auth hardening', () => {
  it('compares tokens in constant time regardless of length', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
  });

  it('accepts the configured bearer token and rejects others', () => {
    const config = { ...base, httpToken: 'secret-token' };
    expect(() => assertAuthorized(req('Bearer secret-token'), config)).not.toThrow();
    expect(() => assertAuthorized(req('Bearer wrong'), config)).toThrow('Unauthorized');
    expect(() => assertAuthorized(req(), config)).toThrow('Unauthorized');
  });

  it('refuses to start when forwarded users are trusted without MCP_HTTP_TOKEN', () => {
    expect(() => assertSafeHttpStartup({ QIDI_TRUST_FORWARDED_USER: 'true' })).toThrow(/MCP_HTTP_TOKEN/);
    expect(() => assertSafeHttpStartup({ QIDI_TRUST_FORWARDED_USER: 'true', MCP_HTTP_TOKEN: 't' })).not.toThrow();
    expect(forwardedHeadersTrusted({ ...base }, { QIDI_TRUST_FORWARDED_USER: 'true' })).toBe(false);
    expect(forwardedHeadersTrusted({ ...base, httpToken: 't' }, { QIDI_TRUST_FORWARDED_USER: 'true' })).toBe(true);
  });
});

describe('tool policy', () => {
  it('denies unknown tools and gates tiers on their own flags', () => {
    expect(checkToolPolicy('qidi_printer_status', {}).allowed).toBe(true);
    expect(checkToolPolicy('qidi_nope', {}).allowed).toBe(false);
    expect(checkToolPolicy('qidi_cancel_print', {}).allowed).toBe(false);
    expect(checkToolPolicy('qidi_cancel_print', { QIDI_ENABLE_CONTROL: 'true' }).allowed).toBe(true);
    expect(checkToolPolicy('qidi_start_print', { QIDI_ENABLE_CONTROL: 'true' }).allowed).toBe(false);
    expect(checkToolPolicy('qidi_start_print', { QIDI_ENABLE_PRINT_START: 'true' }).allowed).toBe(true);
  });
});
