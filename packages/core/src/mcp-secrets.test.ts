import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { reloadConfig } from '@assistant/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptMcpBearerToken, encryptMcpBearerToken } from './mcp-secrets.js';

const ORIGINAL_KEY = process.env.MCP_ENC_KEY;

beforeEach(() => {
  process.env.MCP_ENC_KEY = 'a7'.repeat(32);
  reloadConfig();
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.MCP_ENC_KEY;
  else process.env.MCP_ENC_KEY = ORIGINAL_KEY;
  reloadConfig();
});

describe('MCP bearer credential encryption', () => {
  it('round-trips a credential without storing plaintext', () => {
    const encrypted = encryptMcpBearerToken('owner-secret-token');

    expect(encrypted).not.toContain('owner-secret-token');
    expect(decryptMcpBearerToken(encrypted)).toBe('owner-secret-token');
  });

  it('rejects tampered authenticated ciphertext', () => {
    const encrypted = encryptMcpBearerToken('owner-secret-token');
    const parts = encrypted.split('.');
    parts[3] = `${parts[3]?.slice(0, -2)}aa`;

    expect(() => decryptMcpBearerToken(parts.join('.'))).toThrow();
  });

  it('decrypts credentials written by the v1 key-derivation format', () => {
    const configured = 'a7'.repeat(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      createHash('sha256').update(configured, 'utf8').digest(),
      iv,
    );
    const ciphertext = Buffer.concat([cipher.update('legacy-token', 'utf8'), cipher.final()]);
    const payload = [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');

    expect(decryptMcpBearerToken(payload)).toBe('legacy-token');
  });

  it('rejects a weak or malformed encryption key', () => {
    process.env.MCP_ENC_KEY = 'short-passphrase';
    reloadConfig();

    expect(() => encryptMcpBearerToken('owner-secret-token')).toThrow(/32 random bytes/);
  });
});
