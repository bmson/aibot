import { loadConfig, resetConfigForTest } from '@assistant/config';
import { afterEach, describe, expect, it } from 'vitest';
import { proactiveConfigNotes } from './diagnostics.js';

describe('proactiveConfigNotes', () => {
  afterEach(() => resetConfigForTest());

  const base = { ASSISTANT_MODULES: 'google,push', EMAIL_INGEST_MODE: 'forwarded' };

  it('is silent on an installation that can actually be proactive', () => {
    expect(proactiveConfigNotes(loadConfig(base))).toEqual([]);
  });

  it('names the default ingest mode as the reason forwarded mail never lands', () => {
    // The exact trap: a forwarding rule is set up, the mode is left alone, and
    // the only symptom anywhere is silence. Direct mode does now score and
    // record what it reads, so the note has to name what is actually still
    // broken — forwarded mail cannot pass SPF alignment — rather than the old
    // blanket claim that nothing gets scored.
    const notes = proactiveConfigNotes(loadConfig({ ...base, EMAIL_INGEST_MODE: 'direct' }));
    expect(notes.join(' ')).toContain('EMAIL_INGEST_MODE');
    expect(notes.join(' ')).toMatch(/SPF alignment/);
    expect(notes.join(' ')).toMatch(/dropped as unauthenticated/);
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
