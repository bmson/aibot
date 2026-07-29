import { describe, expect, it } from 'vitest';
import { assistantModuleMetas } from './registry.js';
import { moduleToolLabels } from './ui.js';

/**
 * Tool labels are declared per module and aggregated flat for the web UI, so
 * the failure modes are cross-module: two modules claiming one tool name, or
 * a label that renders as nothing. Pin both here, next to the aggregation.
 */
describe('module tool labels', () => {
  it('never lets two modules label the same tool', () => {
    const owners = new Map<string, string>();
    for (const meta of assistantModuleMetas) {
      for (const tool of Object.keys(meta.ui?.toolLabels ?? {})) {
        const previous = owners.get(tool);
        expect(previous, `${tool} labeled by both ${previous} and ${meta.name}`).toBeUndefined();
        owners.set(tool, meta.name);
      }
    }
    expect(owners.size).toBeGreaterThan(0);
  });

  it('keeps every label renderable and every key namespaced', () => {
    for (const meta of assistantModuleMetas) {
      for (const [tool, labels] of Object.entries(meta.ui?.toolLabels ?? {})) {
        expect(tool, `${meta.name}: ${tool}`).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/);
        expect(labels.present.trim().length, `${tool} present label`).toBeGreaterThan(0);
        expect(labels.past.trim().length, `${tool} past label`).toBeGreaterThan(0);
      }
    }
  });

  it('aggregates both tenses for every declared tool', () => {
    const { present, past } = moduleToolLabels();
    expect(present.get('gmail.send')).toBe('Sending an email');
    expect(past.get('gmail.send')).toBe('Sent an email');
    expect(present.size).toBe(past.size);
  });
});
