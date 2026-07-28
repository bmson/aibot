import { loadConfig, resetConfigForTest } from '@assistant/config';
import { afterEach, describe, expect, it } from 'vitest';
import { gmailSyncEnabled } from './meta.js';

describe('gmailSyncEnabled', () => {
  afterEach(() => resetConfigForTest());

  it('requires the google module', () => {
    expect(
      gmailSyncEnabled(loadConfig({ ASSISTANT_MODULES: 'minimal', GMAIL_SYNC_ENABLED: 'true' })),
    ).toBe(false);
  });

  it('honors explicit true and false values', () => {
    expect(gmailSyncEnabled(loadConfig({ GMAIL_SYNC_ENABLED: 'true' }))).toBe(true);
    resetConfigForTest();
    expect(gmailSyncEnabled(loadConfig({ GMAIL_SYNC_ENABLED: 'false' }))).toBe(false);
  });

  it('defaults on only in production', () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(gmailSyncEnabled(loadConfig({}))).toBe(true);
      resetConfigForTest();
      process.env.NODE_ENV = 'development';
      expect(gmailSyncEnabled(loadConfig({}))).toBe(false);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
