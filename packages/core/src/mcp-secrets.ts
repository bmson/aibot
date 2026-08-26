import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { loadConfig } from '@assistant/config';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

function encryptionKey(): Buffer {
  const configured = loadConfig().MCP_ENC_KEY;
  if (!configured) {
    throw new Error('MCP_ENC_KEY is required to store or use bearer credentials.');
  }
  return createHash('sha256').update(configured, 'utf8').digest();
}

/** Encrypt an MCP credential for database storage. The plaintext never leaves this module. */
export function encryptMcpBearerToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Decrypt only at the network boundary immediately before an MCP request. */
export function decryptMcpBearerToken(payload: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = payload.split('.');
  if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error('Stored MCP credential has an unsupported format.');
  }
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
