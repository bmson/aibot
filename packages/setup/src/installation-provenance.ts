import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';

const sha256Pattern = /^sha256:[0-9a-f]{64}$/i;

/** Hash a local source archive without extracting or executing its contents. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error('must be a regular file');
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'read failed';
    throw new Error(`Cannot read installation archive ${path}: ${detail}`);
  } finally {
    await file?.close().catch(() => undefined);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Verify the exact archive selected by a manifest before it is trusted. */
export async function verifyInstallationArchive(
  path: string,
  expectedDigest: string,
): Promise<string> {
  if (!sha256Pattern.test(expectedDigest)) {
    throw new Error('Installation archive digest must be sha256:<64 hexadecimal characters>');
  }
  const actualDigest = await sha256File(path);
  if (actualDigest.toLowerCase() !== expectedDigest.toLowerCase()) {
    throw new Error(
      `Installation archive digest mismatch: expected ${expectedDigest.toLowerCase()}, got ${actualDigest}`,
    );
  }
  return actualDigest;
}
