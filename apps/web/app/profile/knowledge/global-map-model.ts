import type { KnowledgeMapSnapshot } from '@assistant/application';

export type PositionedKnowledgeNode = KnowledgeMapSnapshot['nodes'][number] & {
  x: number;
  y: number;
};

export const GLOBAL_MAP_WIDTH = 1000;
export const GLOBAL_MAP_HEIGHT = 640;

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
  const byId = new Map(positions.map((node) => [node.id, node]));
  for (let iteration = 0; iteration < 140; iteration += 1) {
    const cooling = 1 - iteration / 140;
    const forces = new Map(positions.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        const a = positions[left];
        const b = positions[right];
        if (!a || !b || a.component !== b.component) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const distanceSquared = Math.max(100, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        dx /= distance;
        dy /= distance;
        const strength = 850 / distanceSquared;
        const af = forces.get(a.id);
        const bf = forces.get(b.id);
        if (af) {
          af.x += dx * strength;
          af.y += dy * strength;
        }
        if (bf) {
          bf.x -= dx * strength;
          bf.y -= dy * strength;
        }
      }
    }
    for (const edge of snapshot.edges) {
      const subject = byId.get(edge.subjectId);
      const object = byId.get(edge.objectId);
      if (!subject || !object) continue;
      const dx = object.x - subject.x;
      const dy = object.y - subject.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = (distance - 96) * 0.0025;
      const sx = (dx / distance) * pull;
      const sy = (dy / distance) * pull;
      const sf = forces.get(subject.id);
      const of = forces.get(object.id);
      if (sf) {
        sf.x += sx;
        sf.y += sy;
      }
      if (of) {
        of.x -= sx;
        of.y -= sy;
      }
    }
    for (const node of positions) {
      const center = componentCenter.get(node.component);
      const force = forces.get(node.id);
      if (!center || !force) continue;
      force.x += (center.x - node.x) * 0.0015;
      force.y += (center.y - node.y) * 0.0015;
      node.x = Math.max(24, Math.min(GLOBAL_MAP_WIDTH - 24, node.x + force.x * 16 * cooling));
      node.y = Math.max(24, Math.min(GLOBAL_MAP_HEIGHT - 24, node.y + force.y * 16 * cooling));
    }
  }
  return positions;
}
