import { resetConfigForTest } from '@assistant/config';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { proxy } from '../../proxy';

afterEach(() => {
  vi.unstubAllEnvs();
  resetConfigForTest();
});

it('opens only exact read routes for packs in Firestore mode', () => {
  vi.stubEnv('PERSISTENCE_DRIVER', 'firestore');
  resetConfigForTest();
  const status = (path: string, method = 'GET') =>
    proxy(new NextRequest(`http://localhost${path}`, { method })).status;
  expect(status('/packs')).toBe(200);
  expect(status('/api/mobile/v1/packs')).toBe(200);
  expect(status('/packs', 'POST')).toBe(503);
  expect(status('/api/mobile/v1/packs', 'POST')).toBe(503);
  expect(status('/packs/nested')).toBe(503);
  expect(status('/api/mobile/v1/packs/nested')).toBe(503);
});
