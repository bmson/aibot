import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@assistant/config', () => ({
  loadConfig: () => ({ PERSISTENCE_DRIVER: 'firestore' }),
}));

import { proxy } from './proxy.js';

const status = (path: string, method: string) =>
  proxy(new NextRequest(`http://localhost${path}`, { method })).status;

describe('Firestore mobile and web ingress', () => {
  it('passes supported anomaly and suggestion writes to authenticated handlers', () => {
    const paths = [
      `/api/mobile/v1/anomalies/${randomUUID()}`,
      `/api/mobile/v1/suggestions/${randomUUID()}`,
    ];
    for (const path of paths) {
      expect(status(path, 'POST')).toBe(200);
      expect(status(path, 'DELETE')).toBe(503);
    }
  });

  it('passes portable mobile overview and document reads', () => {
    const documentId = randomUUID();
    expect(status('/api/mobile/v1/overview', 'GET')).toBe(200);
    expect(status('/api/mobile/v1/documents', 'GET')).toBe(200);
    expect(status(`/api/mobile/v1/documents/${documentId}`, 'GET')).toBe(200);
    // These handlers explicitly return 501 until document processing is portable.
    expect(status('/api/mobile/v1/documents', 'POST')).toBe(200);
    expect(status(`/api/mobile/v1/documents/${documentId}`, 'DELETE')).toBe(200);
  });

  it('keeps malformed IDs, unsupported methods, and SQL-only routes blocked', () => {
    expect(status('/api/mobile/v1/anomalies/not-a-uuid', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/suggestions/not-a-uuid', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/documents/not-a-uuid', 'GET')).toBe(503);
    expect(status('/api/mobile/v1/overview', 'POST')).toBe(503);
    expect(status('/api/mobile/v1/knowledge/graph', 'GET')).toBe(503);
  });

  it('passes only supported knowledge relationship review methods for exact IDs', () => {
    const path = `/api/mobile/v1/knowledge/relations/${randomUUID()}`;
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(status(path, method)).toBe(200);
    }
    expect(status(path, 'PATCH')).toBe(503);
    expect(status('/api/mobile/v1/knowledge/relations/not-a-uuid', 'GET')).toBe(503);
  });
});
