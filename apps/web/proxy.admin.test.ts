import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ PERSISTENCE_DRIVER: 'firestore' }));
vi.mock('@assistant/config', () => ({ loadConfig: () => config }));

import { proxy } from './proxy';

describe.each(['firestore', 'postgres'])('mobile administration in %s mode', (driver) => {
  it('retires browser app pages and preserves the administration pages', () => {
    config.PERSISTENCE_DRIVER = driver;
    for (const path of [
      '/',
      '/chat',
      `/chat/${randomUUID()}`,
      '/profile',
      '/tasks',
      '/documents',
    ]) {
      const result = proxy(new NextRequest(`https://assistant.test${path}`));
      expect(result.status).toBe(307);
      expect(result.headers.get('location')).toBe('https://assistant.test/settings');
      expect(
        proxy(new NextRequest(`https://assistant.test${path}`, { method: 'POST' })).status,
      ).toBe(410);
    }
    for (const path of [
      '/settings',
      '/audit',
      `/audit/${randomUUID()}`,
      '/signin',
      '/setup',
      '/security',
    ])
      expect(proxy(new NextRequest(`https://assistant.test${path}`)).status).toBe(200);
    expect(
      proxy(new NextRequest('https://assistant.test/settings', { method: 'POST' })).status,
    ).toBe(200);
    expect(proxy(new NextRequest('https://assistant.test/audit', { method: 'POST' })).status).toBe(
      405,
    );
    expect(proxy(new NextRequest('https://assistant.test/api/mobile/v1/bootstrap')).status).toBe(
      200,
    );
    expect(proxy(new NextRequest('https://assistant.test/api/auth/session')).status).toBe(200);
  });
});
