import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@assistant/config';
import { describe, expect, it } from 'vitest';
import { assistantModuleMetas } from './registry.js';

/**
 * docs/modules.md carries a hand-maintained module table. Full generation is
 * blocked (the "Required settings" column reflects each readiness predicate,
 * which is not introspectable), so this pins what CAN be checked: one row per
 * module in registry order, and no setting named that the module does not
 * declare in configKeys. A module added without a doc row — or a doc row
 * naming a key the module never reads — fails here instead of drifting.
 */
describe('docs/modules.md parity', () => {
  const doc = readFileSync(path.join(repoRoot, 'docs/modules.md'), 'utf8');
  // Table rows look like: | `google` | ... | `KEY_A`, `KEY_B` | ... |
  const rows = [...doc.matchAll(/^\| `([a-z]+)` \|(.+)\|$/gm)].map((match) => ({
    name: match[1] as string,
    cells: (match[2] as string).split('|').map((cell) => cell.trim()),
  }));

  it('has exactly one row per module, in registry order', () => {
    expect(rows.map((row) => row.name)).toEqual(assistantModuleMetas.map((meta) => meta.name));
  });

  it('only names settings the module declares in configKeys', () => {
    for (const row of rows) {
      const meta = assistantModuleMetas.find((candidate) => candidate.name === row.name);
      if (!meta) continue; // covered by the ordering assertion
      const settingsCell = row.cells[1] ?? '';
      for (const [, key] of settingsCell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
        expect(
          meta.configKeys.includes(key as (typeof meta.configKeys)[number]),
          `${row.name} row names ${key}, which is not in its configKeys`,
        ).toBe(true);
      }
    }
  });
});
