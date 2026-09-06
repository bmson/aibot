import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerSituationTools } from './situations.js';

describe('situation tool boundaries', () => {
  const registry = new ToolRegistry();
  registerSituationTools(registry);
  it('never exposes owner packs or memory writes to external senders', () => {
    expect(registry.toolsForTask('unknown')).toEqual([]);
    expect(registry.toolsForTask('known')).toEqual([]);
    expect(registry.toolsForTask('owner')).toHaveLength(4);
  });
  it('requires exact owner approval for writes even with blanket autonomy', () => {
    const tool = registry.get('situations.change');
    expect(tool?.tool.risk).toBe('approval');
    expect(tool?.flags.autonomyFloor).toBe(true);
    expect(tool?.flags.writesMemory).toBe(true);
    expect(tool?.flags.blanketAllowIneligible).toBe(true);
    expect(registry.smsApprovable('situations.change')).toBe(false);
  });
  it('marks retrieved source/decision text as untrusted content', () => {
    for (const name of ['situations.read', 'situations.sources', 'situations.decisions']) {
      expect(registry.resultIsUntrusted(name)).toBe(true);
      expect(registry.get(name)?.flags.confidentialRead).toBe(true);
    }
  });
});
