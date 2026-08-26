import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { loadConfig } from '@assistant/config';

const VERSION = 'v2';
const LEGACY_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

function encryptionKey(version = VERSION): Buffer {
  const configured = loadConfig().MCP_ENC_KEY;
  if (!configured) {
    throw new Error('MCP_ENC_KEY is required to store or use bearer credentials.');
  }
  // v1 derived a key from an arbitrary string. Keep that read path so credentials
  // saved during the initial rollout remain usable while all new writes require
  // an explicit, high-entropy 256-bit key.
  if (version === LEGACY_VERSION) return createHash('sha256').update(configured, 'utf8').digest();
  if (!/^[0-9a-f]{64}$/i.test(configured)) {
    throw new Error('MCP_ENC_KEY must be 32 random bytes encoded as 64 hex characters.');
  }
  return Buffer.from(configured, 'hex');
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
  if (
    (version !== VERSION && version !== LEGACY_VERSION) ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue
  ) {
    throw new Error('Stored MCP credential has an unsupported format.');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(version),
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
