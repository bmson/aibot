import type { KnowledgeMapSnapshot } from '@assistant/application';

export type PositionedKnowledgeNode = KnowledgeMapSnapshot['nodes'][number] & {
  x: number;
  y: number;
};

export const GLOBAL_MAP_WIDTH = 1000;
export const GLOBAL_MAP_HEIGHT = 640;

/** Parallel evidence stays attached to one directed, time-qualified claim. */
export function knowledgeConnections(snapshot: KnowledgeMapSnapshot, entityId: string) {
  const grouped = new Map<
    string,
    {
      id: string;
      edge: KnowledgeMapSnapshot['edges'][number];
      sources: KnowledgeMapSnapshot['edges'];
      confirmed: boolean;
    }
  >();
  for (const edge of snapshot.edges) {
    if (edge.subjectId !== entityId && edge.objectId !== entityId) continue;
    const key = JSON.stringify([
      edge.subjectId,
      edge.predicate,
      edge.objectId,
      edge.validFrom,
      edge.validUntil,
    ]);
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.sources.some((source) => source.sourceMemoryId === edge.sourceMemoryId))
        existing.sources.push(edge);
      existing.confirmed ||= edge.reviewStatus === 'confirmed';
    } else {
      grouped.set(key, {
        id: key,
        edge,
        sources: [edge],
        confirmed: edge.reviewStatus === 'confirmed',
      });
    }
  }
  return [...grouped.values()].sort(
    (a, b) =>
      Number(b.confirmed) - Number(a.confirmed) ||
      a.edge.presentation.sentence.localeCompare(b.edge.presentation.sentence),
  );
}

const ITERATIONS = 140;
/** Beyond ~340px apart the repulsion term is below a pixel of total travel. */
const REPULSION_CUTOFF_SQUARED = 340 * 340;

function hash(value: string): number {
  let result = 2166136261;
  for (const char of value) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

/** Deterministic force layout: identical graph input always produces identical coordinates. */
export function layoutKnowledgeMap(snapshot: KnowledgeMapSnapshot): PositionedKnowledgeNode[] {
  if (snapshot.nodes.length === 0) return [];
  const componentIds = [...new Set(snapshot.nodes.map((node) => node.component))];
  const columns = Math.max(1, Math.ceil(Math.sqrt(componentIds.length)));
  const rows = Math.max(1, Math.ceil(componentIds.length / columns));
  const componentCenter = new Map<number, { x: number; y: number }>();
  componentIds.forEach((component, index) => {
    componentCenter.set(component, {
      x: ((index % columns) + 0.5) * (GLOBAL_MAP_WIDTH / columns),
      y: (Math.floor(index / columns) + 0.5) * (GLOBAL_MAP_HEIGHT / rows),
    });
  });
  const positions = snapshot.nodes.map((node) => {
    const center = componentCenter.get(node.component) ?? {
      x: GLOBAL_MAP_WIDTH / 2,
      y: GLOBAL_MAP_HEIGHT / 2,
    };
    const seed = hash(node.id);
    const angle = ((seed % 10_000) / 10_000) * Math.PI * 2;
    const radius = 28 + ((seed >>> 8) % 90);
    return {
      ...node,
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  });
  // Everything below addresses nodes by index rather than id. The relaxation
  // is O(iterations x nodes^2) and runs synchronously before first paint, so
  // the per-pair map lookups and the per-iteration allocation this replaces
  // were most of its cost. The force accumulators are allocated once and
  // zeroed each pass; `indexById` resolves each edge's endpoints once.
  const indexById = new Map(positions.map((node, index) => [node.id, index]));
  const edgePairs = snapshot.edges.flatMap((edge) => {
    const subject = indexById.get(edge.subjectId);
    const object = indexById.get(edge.objectId);
    return subject === undefined || object === undefined ? [] : [[subject, object] as const];
  });
  const forceX = new Float64Array(positions.length);
  const forceY = new Float64Array(positions.length);
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const cooling = 1 - iteration / ITERATIONS;
    forceX.fill(0);
    forceY.fill(0);
    for (let left = 0; left < positions.length; left += 1) {
      const a = positions[left];
      if (!a) continue;
      for (let right = left + 1; right < positions.length; right += 1) {
        const b = positions[right];
        if (!b || a.component !== b.component) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const distanceSquared = Math.max(100, dx * dx + dy * dy);
        // Past this separation the repulsion is too small to move a node a
        // visible fraction of a pixel, so computing it is pure cost.
        if (distanceSquared > REPULSION_CUTOFF_SQUARED) continue;
        const distance = Math.sqrt(distanceSquared);
        dx /= distance;
        dy /= distance;
        const strength = 850 / distanceSquared;
        forceX[left] += dx * strength;
        forceY[left] += dy * strength;
        forceX[right] -= dx * strength;
        forceY[right] -= dy * strength;
      }
    }
    for (const [subjectIndex, objectIndex] of edgePairs) {
      const subject = positions[subjectIndex];
      const object = positions[objectIndex];
      if (!subject || !object) continue;
      const dx = object.x - subject.x;
      const dy = object.y - subject.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = (distance - 96) * 0.0025;
      const sx = (dx / distance) * pull;
      const sy = (dy / distance) * pull;
      forceX[subjectIndex] += sx;
      forceY[subjectIndex] += sy;
      forceX[objectIndex] -= sx;
      forceY[objectIndex] -= sy;
    }
    for (let index = 0; index < positions.length; index += 1) {
      const node = positions[index];
      const center = node ? componentCenter.get(node.component) : undefined;
      if (!node || !center) continue;
      const fx = (forceX[index] as number) + (center.x - node.x) * 0.0015;
      const fy = (forceY[index] as number) + (center.y - node.y) * 0.0015;
      node.x = Math.max(24, Math.min(GLOBAL_MAP_WIDTH - 24, node.x + fx * 16 * cooling));
      node.y = Math.max(24, Math.min(GLOBAL_MAP_HEIGHT - 24, node.y + fy * 16 * cooling));
    }
  }
  // A small neighborhood used to occupy a tiny patch in a large empty canvas.
  // Fit coordinates, not the SVG transform, so labels and hit targets keep
  // their readable size and pan/zoom still start at a predictable origin.
  const minX = Math.min(...positions.map((node) => node.x));
  const maxX = Math.max(...positions.map((node) => node.x));
  const minY = Math.min(...positions.map((node) => node.y));
  const maxY = Math.max(...positions.map((node) => node.y));
  const scale = Math.min(
    3,
    (GLOBAL_MAP_WIDTH - 160) / Math.max(1, maxX - minX),
    (GLOBAL_MAP_HEIGHT - 160) / Math.max(1, maxY - minY),
  );
  return positions.map((node) => ({
    ...node,
    x: GLOBAL_MAP_WIDTH / 2 + (node.x - (minX + maxX) / 2) * scale,
    y: GLOBAL_MAP_HEIGHT / 2 + (node.y - (minY + maxY) / 2) * scale,
  }));
}
