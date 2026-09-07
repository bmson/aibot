import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  snapshot: vi.fn(),
  person: vi.fn(),
  neighborhood: vi.fn(),
}));
vi.mock('@assistant/application', () => ({
  getKnowledgeMapSnapshot: mocks.snapshot,
  getKnowledgeGraphNeighborhood: mocks.neighborhood,
}));
vi.mock('@assistant/application/people', () => ({ getPersonDossier: mocks.person }));
vi.mock('@/lib/server', () => ({ getDb: () => ({}) }));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { GET } from './route';

const person = '12345678-1234-4234-8234-123456789abc';
const entity = '22345678-1234-4234-8234-123456789abc';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(true);
  mocks.snapshot.mockResolvedValue({ nodes: [], edges: [], totalEdges: 0, truncated: false });
});
describe('native relationship graph', () => {
  it('requires authentication before reading the graph', async () => {
    mocks.auth.mockResolvedValue(false);
    expect(
      (await GET(new Request('https://example.com/api/mobile/v1/knowledge/graph'))).status,
    ).toBe(401);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('rejects malformed focus identifiers', async () => {
    expect(
      (await GET(new Request('https://example.com/api/mobile/v1/knowledge/graph?entity=bad')))
        .status,
    ).toBe(400);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('resolves an exact contact graph anchor and preserves bounded snapshot metadata', async () => {
    mocks.person.mockResolvedValue({ entityId: entity });
    mocks.snapshot.mockResolvedValue({
      nodes: [{ id: entity, contactId: person }],
      edges: [],
      totalEdges: 520,
      truncated: true,
    });
    const response = await GET(
      new Request(`https://example.com/api/mobile/v1/knowledge/graph?person=${person}`),
    );
    expect(mocks.snapshot).toHaveBeenCalledWith({}, { entityId: entity, query: '' });
    expect(await response.json()).toMatchObject({
      focusId: entity,
      totalEdges: 520,
      truncated: true,
    });
  });
  it('does not fall back to everyone when a contact has no graph node', async () => {
    mocks.person.mockResolvedValue({ entityId: null });
    const response = await GET(
      new Request(`https://example.com/api/mobile/v1/knowledge/graph?person=${person}`),
    );
    expect(await response.json()).toMatchObject({ nodes: [], edges: [], focusId: null });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  it('retains an isolated selected item and reports a missing item accurately', async () => {
    mocks.neighborhood.mockResolvedValue({
      entity: { id: entity, label: 'Robin', kind: 'person' },
    });
    const response = await GET(
      new Request(`https://example.com/api/mobile/v1/knowledge/graph?entity=${entity}`),
    );
    expect(await response.json()).toMatchObject({
      nodes: [{ id: entity, degree: 0 }],
      focusId: entity,
    });
    mocks.snapshot.mockResolvedValue({ nodes: [], edges: [], totalEdges: 0, truncated: false });
    mocks.neighborhood.mockResolvedValue({ entity: null });
    expect(
      (await GET(new Request(`https://example.com/api/mobile/v1/knowledge/graph?entity=${entity}`)))
        .status,
    ).toBe(404);
  });
});
