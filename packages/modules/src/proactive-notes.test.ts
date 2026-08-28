import { loadConfig, resetConfigForTest } from '@assistant/config';
import { afterEach, describe, expect, it } from 'vitest';
import { proactiveConfigNotes } from './diagnostics.js';

describe('proactiveConfigNotes', () => {
  afterEach(() => resetConfigForTest());

  const base = { ASSISTANT_MODULES: 'google,push', EMAIL_INGEST_MODE: 'forwarded' };

  it('is silent on an installation that can actually be proactive', () => {
    expect(proactiveConfigNotes(loadConfig(base))).toEqual([]);
  });

  it('names the default ingest mode as the reason the briefing is empty', () => {
    // The exact trap: a forwarding rule is set up, the mode is left alone, and
    // the only symptom anywhere is silence.
    const notes = proactiveConfigNotes(loadConfig({ ...base, EMAIL_INGEST_MODE: 'direct' }));
    expect(notes.join(' ')).toContain('EMAIL_INGEST_MODE');
    expect(notes.join(' ')).toMatch(/dropped rather than scored/);
  });

  it('says nothing about mail when google is not installed', () => {
    const notes = proactiveConfigNotes(
      loadConfig({ ASSISTANT_MODULES: 'push', EMAIL_INGEST_MODE: 'direct' }),
    );
    expect(notes.join(' ')).not.toContain('EMAIL_INGEST_MODE');
  });

  it('flags mail sync being switched off', () => {
    const notes = proactiveConfigNotes(loadConfig({ ...base, GMAIL_SYNC_ENABLED: 'false' }));
    expect(notes.join(' ')).toContain('GMAIL_SYNC_ENABLED');
  });

  it('warns when nothing can reach the phone at all', () => {
    const notes = proactiveConfigNotes(
      loadConfig({ ASSISTANT_MODULES: 'google', EMAIL_INGEST_MODE: 'forwarded' }),
    );
    expect(notes.join(' ')).toMatch(/only appear when you open the dashboard/);
  });
});
