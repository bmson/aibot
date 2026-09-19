import { describe, expect, it, vi } from 'vitest';
import type { SettingsPersistence } from './settings-port.js';
import { createSettingsFacade } from './settings-port.js';

function fixture() {
  const owner = {
    id: 'owner',
    name: 'Owner',
    email: 'owner@example.test',
    calendarId: null,
    phoneE164: null,
    avatarUrl: null,
    signature: '',
    timezone: 'UTC',
    locale: 'en-US',
    workspacePrefix: 'owner',
    browserProfilePath: null,
    credentialRefs: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const updateNotificationPrefs = vi.fn(async () => true);
  const updateOwner = vi.fn(async () => true);
  const persistence = {
    kind: 'settings-persistence',
    settings: {
      kind: 'settings-repository',
      getOwner: async () => owner,
      getNotificationPrefs: async () => ({
        quietStartMin: 75,
        quietEndMin: 360,
        ambientDailyCap: 4,
      }),
      countHeldPings: async () => ({ quietHours: 2, dailyCap: 1 }),
      updateNotificationPrefs,
      updateOwner,
    },
    schedules: {
      kind: 'schedule-repository',
      listPage: async () => ({ items: [], nextCursor: null }),
      setOwnerEnabled: async () => true,
    },
    reminders: { kind: 'reminder-repository', cancel: async () => ({ cancelled: true }) },
    policies: {
      kind: 'approval-policy-repository',
      list: async () => [],
      setEnabled: async () => true,
      delete: async () => true,
    },
  } as unknown as SettingsPersistence;
  return { facade: createSettingsFacade(persistence), updateNotificationPrefs, updateOwner };
}

describe('portable settings facade', () => {
  it('preserves overview preference formatting without a SQL dependency', async () => {
    const { facade } = fixture();
    await expect(facade.getOverview()).resolves.toMatchObject({
      agent: { id: 'owner' },
      notificationPrefs: {
        quietStart: '01:15',
        quietEnd: '06:00',
        ambientDailyCap: '4',
        heldLast24h: { quietHours: 2, dailyCap: 1 },
      },
    });
  });

  it('keeps the exact validation and normalization behavior', async () => {
    const { facade, updateNotificationPrefs, updateOwner } = fixture();
    await expect(
      facade.updateNotificationPrefs({
        quietStart: '25:00',
        quietEnd: '06:00',
        ambientDailyCap: '',
      }),
    ).resolves.toEqual({ error: 'Quiet hours need HH:MM times, or be left empty.' });
    await expect(
      facade.updateNotificationPrefs({ quietStart: '22:00', quietEnd: '', ambientDailyCap: '101' }),
    ).resolves.toEqual({ error: 'The daily ping limit must be a whole number between 1 and 100.' });
    await expect(
      facade.updateNotificationPrefs({ quietStart: '22:00', quietEnd: '', ambientDailyCap: '8' }),
    ).resolves.toEqual({});
    expect(updateNotificationPrefs).toHaveBeenCalledWith('owner', {
      quietStartMin: null,
      quietEndMin: null,
      ambientDailyCap: 8,
    });
    await expect(
      facade.updateAssistantSettings({ timezone: 'Not/AZone', locale: 'en', signature: '' }),
    ).resolves.toEqual({ error: 'Unknown timezone "Not/AZone".' });
    await expect(
      facade.updateAssistantSettings({
        timezone: ' UTC ',
        locale: ' en-US ',
        signature: ` ${'x'.repeat(510)} `,
      }),
    ).resolves.toEqual({});
    expect(updateOwner).toHaveBeenCalledWith('owner', {
      timezone: 'UTC',
      locale: 'en-US',
      signature: 'x'.repeat(500),
    });
  });
});
