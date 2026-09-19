import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { createDb } from './client.js';
import { proactivePings } from './schema.js';
import { createPostgresSettingsRepository } from './settings-repository.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe('PostgreSQL settings repository', () => {
  it('matches owner preference mutation and held-ping scope', async () => {
    if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
      throw new Error('Requires isolated _test database');
    const db = createDb(DATABASE_URL);
    try {
      await expect(
        db.transaction(async (tx) => {
          const repository = createPostgresSettingsRepository(tx as unknown as Db);
          const owner = await repository.getOwner();
          if (!owner) throw new Error('Settings test requires a seeded owner');
          await expect(
            repository.updateNotificationPrefs(owner.id, {
              quietStartMin: 75,
              quietEndMin: 360,
              ambientDailyCap: 4,
            }),
          ).resolves.toBe(true);
          await expect(repository.getNotificationPrefs(owner.id)).resolves.toEqual({
            quietStartMin: 75,
            quietEndMin: 360,
            ambientDailyCap: 4,
          });
          await tx.insert(proactivePings).values([
            {
              id: randomUUID(),
              agentId: owner.id,
              channel: 'in_app',
              urgency: 'ambient',
              delivered: false,
              reason: 'quiet-hours',
              createdAt: new Date('2026-09-19T19:00:00Z'),
            },
            {
              id: randomUUID(),
              agentId: owner.id,
              channel: 'in_app',
              urgency: 'ambient',
              delivered: false,
              reason: 'daily-cap',
              createdAt: new Date('2026-09-17T19:00:00Z'),
            },
          ]);
          await expect(
            repository.countHeldPings(owner.id, new Date('2026-09-18T20:00:00Z')),
          ).resolves.toEqual({ quietHours: 1, dailyCap: 0 });
          throw new Error('rollback settings fixture');
        }),
      ).rejects.toThrow('rollback settings fixture');
    } finally {
      await db.$client.end();
    }
  });
});
