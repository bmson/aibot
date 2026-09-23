import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@assistant/config', () => ({
  loadConfig: () => ({ PERSISTENCE_DRIVER: 'firestore' }),
}));

import { proxy } from './proxy.js';

describe('Firestore mutation ingress', () => {
  it('passes supported Pack and anomaly writes to their authenticated handlers', () => {
    for (const path of [
      '/packs',
      '/api/mobile/v1/packs',
      `/api/mobile/v1/anomalies/${randomUUID()}`,
    ]) {
      expect(proxy(new NextRequest(`http://localhost${path}`, { method: 'POST' })).status).toBe(
        200,
      );
      expect(proxy(new NextRequest(`http://localhost${path}`, { method: 'DELETE' })).status).toBe(
        503,
      );
    }
  });

  it('keeps invalid anomaly IDs blocked at the proxy', () => {
    expect(
      proxy(
        new NextRequest('http://localhost/api/mobile/v1/anomalies/not-a-uuid', {
          method: 'POST',
        }),
      ).status,
    ).toBe(503);
  });
});
