import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configKeyNames, repoRoot } from './index.js';

/**
 * `.env.example` is the installation's discovery surface: a setting missing
 * there is a setting nobody finds until something breaks. This pins the file
 * to the schema so adding a config key without documenting it fails CI.
 */
describe('.env.example parity', () => {
  const envExample = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  // A key counts as documented when it appears at the start of a line as
  // `KEY=` or as a commented-out `# KEY=` placeholder.
  const documented = new Set(
    [...envExample.matchAll(/^#? ?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
  );

  it('documents every schema key', () => {
    const missing = configKeyNames.filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });
});
