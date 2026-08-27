import { describe, expect, it } from 'vitest';
import {
  arrowhead,
  CANVAS_NODE_LIMIT,
  CX,
  CY,
  clampScale,
  edgeLine,
  entityHref,
  INITIAL_VIEWPORT,
  initialCanvas,
  KIND_PAGE_SIZE,
  MAX_SCALE,
  type MapEdgeInput,
  MIN_SCALE,
  mergeExpansion,
  panBy,
  ringRadii,
  toViewPoint,
  zoomAt,
} from '@/app/profile/knowledge/local-map-model';

const center = { id: 'c', label: 'Ada', kind: 'person' };

function edge(id: string, otherId: string, outbound = true): MapEdgeInput {
  return {
    id,
    predicate: 'knows',
    outbound,
    reviewStatus: 'confirmed',
    other: { id: otherId, label: `Node ${otherId}`, kind: 'project' },
  };
}

describe('entityHref', () => {
  it('carries the current search and filter so the map never drops them', () => {
    expect(entityHref('e1', 'ada', 'person')).toBe(
      '/profile/knowledge?q=ada&kind=person&entity=e1',
    );
  });

  it('omits empty params but always names the entity', () => {
    expect(entityHref('e1', '', '')).toBe('/profile/knowledge?entity=e1');
  });
});

describe('initialCanvas', () => {
  it('places the centre at the centre and neighbours on the ring', () => {
    const canvas = initialCanvas(center, [edge('e1', 'a'), edge('e2', 'b')]);
    expect(canvas.nodes).toHaveLength(3);
    expect(canvas.nodes[0]).toMatchObject({ id: 'c', x: CX, y: CY, ring: 0 });
    const ring = canvas.nodes.filter((node) => node.ring === 1);
    expect(ring.map((node) => node.id).sort()).toEqual(['a', 'b']);
    for (const node of ring) {
      expect(Math.hypot(node.x - CX, node.y - CY)).toBeGreaterThan(100);
    }
  });

  it('points outbound edges away from the centre and inbound ones at it', () => {
    const canvas = initialCanvas(center, [edge('out', 'a', true), edge('in', 'b', false)]);
    const outbound = canvas.edges.find((item) => item.id === 'out');
    const inbound = canvas.edges.find((item) => item.id === 'in');
    expect(outbound).toMatchObject({ subjectId: 'c', objectId: 'a' });
    expect(inbound).toMatchObject({ subjectId: 'b', objectId: 'c' });
  });

  it('draws two predicates to the same neighbour as one node and two edges', () => {
    const canvas = initialCanvas(center, [edge('e1', 'a'), edge('e2', 'a')]);
    expect(canvas.nodes.filter((node) => node.id === 'a')).toHaveLength(1);
    expect(canvas.edges).toHaveLength(2);
  });

  it('drops self-loops, which would draw as a zero-length line', () => {
    const canvas = initialCanvas(center, [edge('self', 'c')]);
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.edges).toHaveLength(0);
  });

  it('widens the ring as degree grows so hubs spread instead of stacking', () => {
    expect(ringRadii(6)).toEqual(ringRadii(12));
    expect(ringRadii(120).rx).toBeGreaterThan(ringRadii(12).rx);
    expect(ringRadii(10000).rx).toBeLessThanOrEqual(230 * 3);
  });

  it('bands neighbours into per-kind sectors capped at a page each', () => {
    const many: MapEdgeInput[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `d${index}`,
        predicate: 'on',
        outbound: true,
        reviewStatus: 'confirmed' as const,
        other: {
          id: `date-${index}`,
          label: `2026-03-${String(index + 1).padStart(2, '0')}`,
          kind: 'date',
        },
      })),
      edge('p1', 'person-a'),
      edge('p2', 'person-b'),
    ];
    const canvas = initialCanvas(center, many);

    // The 30 dates page at KIND_PAGE_SIZE and collapse into one pager node;
    // the two people render whole.
    const dates = canvas.nodes.filter((node) => node.kind === 'date' && !node.aggregate);
    expect(dates).toHaveLength(KIND_PAGE_SIZE);
    const pager = canvas.nodes.find((node) => node.aggregate);
    expect(pager).toMatchObject({ kind: 'date', label: '+18 more' });
    expect(canvas.nodes.filter((node) => node.kind === 'project')).toHaveLength(2);

    // Paged-out neighbours drop their edges too — nothing invisible is drawn
    // or announced.
    expect(canvas.edges).toHaveLength(KIND_PAGE_SIZE + 2);

    // Kinds occupy distinct sectors: with two kinds, project ranks before date
    // in KIND_ORDER, so projects take the right half and dates the left.
    const projects = canvas.nodes.filter((node) => node.kind === 'project');
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.every((node) => node.x >= CX - 0.001)).toBe(true);
    expect(dates.every((node) => node.x <= CX + 0.001)).toBe(true);
    expect(pager && pager.x <= CX + 0.001).toBe(true);
  });

  it('reveals the next page of a kind without reshuffling it', () => {
    const many: MapEdgeInput[] = Array.from({ length: 30 }, (_, index) => ({
      id: `d${index}`,
      predicate: 'on',
      outbound: true,
      reviewStatus: 'confirmed' as const,
      other: {
        id: `date-${index}`,
        label: `Day ${String(index + 1).padStart(2, '0')}`,
        kind: 'date',
      },
    }));
    const first = initialCanvas(center, many);
    const firstIds = first.nodes
      .filter((node) => node.kind === 'date' && !node.aggregate)
      .map((n) => n.id);

    const second = initialCanvas(center, many, { date: 2 });
    const secondIds = second.nodes
      .filter((node) => node.kind === 'date' && !node.aggregate)
      .map((n) => n.id);
    expect(secondIds.slice(0, KIND_PAGE_SIZE)).toEqual(firstIds);
    expect(secondIds).toHaveLength(KIND_PAGE_SIZE * 2);
    expect(second.nodes.find((node) => node.aggregate)?.label).toBe('+6 more');

    const third = initialCanvas(center, many, { date: 3 });
    expect(third.nodes.some((node) => node.aggregate)).toBe(false);
    expect(third.nodes.filter((node) => node.kind === 'date')).toHaveLength(30);
  });
});

describe('mergeExpansion', () => {
  it('fans new children out from the parent and links them', () => {
    const canvas = initialCanvas(center, [edge('e1', 'a')]);
    const merged = mergeExpansion(canvas, 'a', [edge('e2', 'x'), edge('e3', 'y'), edge('e4', 'z')]);
    expect(merged.added).toBe(3);
    const parent = merged.canvas.nodes.find((node) => node.id === 'a');
    const children = merged.canvas.nodes.filter((node) => node.ring === 2);
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.parentId).toBe('a');
      expect(Math.hypot(child.x - (parent?.x ?? 0), child.y - (parent?.y ?? 0))).toBeCloseTo(
        110,
        0,
      );
    }
    expect(merged.canvas.edges).toHaveLength(4);
  });

  it('dedupes entities already on the canvas but keeps edges between visible nodes', () => {
    const canvas = initialCanvas(center, [edge('e1', 'a'), edge('e2', 'b')]);
    const merged = mergeExpansion(canvas, 'a', [edge('e3', 'b', true), edge('e4', 'x')]);
    // 'b' was already visible: no new node, but the a-b edge is drawn.
    expect(merged.canvas.nodes.filter((node) => node.id === 'b')).toHaveLength(1);
    expect(merged.canvas.edges.some((item) => item.id === 'e3')).toBe(true);
    expect(merged.added).toBe(1);
  });

  it('never draws the same edge twice', () => {
    const canvas = initialCanvas(center, [edge('e1', 'a')]);
    const merged = mergeExpansion(canvas, 'a', [edge('e1', 'c')]);
    expect(merged.canvas.edges.filter((item) => item.id === 'e1')).toHaveLength(1);
  });

  it('refuses to grow past the canvas cap and says so', () => {
    let canvas = initialCanvas(center, [edge('e1', 'a')]);
    canvas = {
      nodes: [
        ...canvas.nodes,
        ...Array.from({ length: CANVAS_NODE_LIMIT - 2 }, (_, index) => ({
          id: `pad-${index}`,
          label: `Pad ${index}`,
          kind: 'topic',
          x: 0,
          y: 0,
          ring: 1,
          parentId: 'c',
        })),
      ],
      edges: canvas.edges,
    };
    const merged = mergeExpansion(canvas, 'a', [edge('x1', 'n1'), edge('x2', 'n2')]);
    expect(merged.canvas.nodes).toHaveLength(CANVAS_NODE_LIMIT);
    expect(merged.added).toBe(0);
    expect(merged.capped).toBe(true);
  });

  it('is a no-op for a parent that is not on the canvas', () => {
    const canvas = initialCanvas(center, [edge('e1', 'a')]);
    const merged = mergeExpansion(canvas, 'ghost', [edge('e9', 'x')]);
    expect(merged.canvas).toBe(canvas);
    expect(merged.added).toBe(0);
  });
});

describe('viewport math', () => {
  it('clamps zoom to its bounds', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(zoomAt(INITIAL_VIEWPORT, 99, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAt({ x: 0, y: 0, scale: MIN_SCALE }, 0.5, 0, 0).scale).toBe(MIN_SCALE);
  });

  it('keeps the pointed-at viewBox point fixed while zooming', () => {
    const before = { x: 10, y: -20, scale: 1 };
    const after = zoomAt(before, 2, 100, 80);
    // The point (100, 80) in screen space names the same canvas point before
    // and after: (screen - offset) / scale is invariant.
    expect((100 - after.x) / after.scale).toBeCloseTo((100 - before.x) / before.scale);
    expect((80 - after.y) / after.scale).toBeCloseTo((80 - before.y) / before.scale);
  });

  it('pans by a delta', () => {
    expect(panBy(INITIAL_VIEWPORT, 12, -8)).toEqual({ x: 12, y: -8, scale: 1 });
  });

  it('maps client pixels into viewBox units', () => {
    const point = toViewPoint(200, 50, { left: 100, top: 10, width: 760, height: 420 });
    expect(point.x).toBeCloseTo(100);
    expect(point.y).toBeCloseTo(40);
  });
});

describe('edge geometry', () => {
  it('trims both ends so the line meets neither disc', () => {
    const line = edgeLine({ x: 0, y: 0 }, { x: 100, y: 0 }, 13, 7);
    expect(line.x1).toBeCloseTo(16);
    expect(line.x2).toBeCloseTo(90);
    expect(line.ux).toBeCloseTo(1);
    expect(line.uy).toBeCloseTo(0);
  });

  it('draws the arrowhead square to its edge', () => {
    expect(arrowhead(10, 10, 1, 0)).toBe('10.00,10.00 1.00,13.60 1.00,6.40');
  });
});
