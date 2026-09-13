import type { KnowledgeMapSnapshot } from '@assistant/application';

export type PositionedKnowledgeNode = KnowledgeMapSnapshot['nodes'][number] & {
  x: number;
  y: number;
};

export const GLOBAL_MAP_WIDTH = 1000;
export const GLOBAL_MAP_HEIGHT = 640;

/**
 * How many neighbours one ring holds. A ring is for reading, not for
 * completeness: past a dozen spokes the names start competing for the same
 * arc, and the owner is better served by the searchable list that holds every
 * connection anyway. Ranked by how connected each neighbour is, so the first
 * ring is the one worth seeing.
 */
export const FOCUS_RING_SIZE = 12;

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

/**
 * One neighbour of the item in hand, placed on the focus ring.
 *
 * `label` is the vocabulary's direction-free phrase and `outbound` says which
 * way the stored claim points; the spoke draws an arrowhead from that rather
 * than rewording the relation, so an incoming claim is never quietly reversed.
 */
export interface FocusSpoke {
  node: PositionedKnowledgeNode;
  label: string;
  outbound: boolean;
  /** Distinct directed, time-qualified claims — not the number of sources. */
  claims: number;
  needsReview: boolean;
}

export interface FocusLayout {
  centre: PositionedKnowledgeNode;
  spokes: FocusSpoke[];
  /** Every neighbour in this snapshot, whether or not the ring has room. */
  total: number;
  page: number;
  pages: number;
}

/**
 * Every distinct neighbour of `entityId`, most-connected first.
 *
 * Parallel evidence collapses the way `knowledgeConnections` collapses it —
 * one entry per neighbour, counting distinct claims rather than source rows —
 * so a fact recorded in six emails is one line on the ring, not six.
 */
export function focusNeighbors(
  snapshot: KnowledgeMapSnapshot,
  entityId: string,
): Array<Omit<FocusSpoke, 'node'> & { node: KnowledgeMapSnapshot['nodes'][number] }> {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const grouped = new Map<
    string,
    {
      node: KnowledgeMapSnapshot['nodes'][number];
      label: string;
      outbound: boolean;
      claims: Set<string>;
      needsReview: boolean;
    }
  >();
  for (const edge of snapshot.edges) {
    if (edge.subjectId !== entityId && edge.objectId !== entityId) continue;
    const outbound = edge.subjectId === entityId;
    const otherId = outbound ? edge.objectId : edge.subjectId;
    // A self-referential claim has no second endpoint to place on the ring; it
    // still belongs in the inspector, which reads the edges directly.
    if (otherId === entityId) continue;
    const node = byId.get(otherId);
    if (!node) continue;
    const claim = JSON.stringify([edge.predicate, outbound, edge.validFrom, edge.validUntil]);
    const existing = grouped.get(otherId);
    if (existing) {
      existing.claims.add(claim);
      existing.needsReview ||= edge.reviewStatus === 'unreviewed';
      continue;
    }
    grouped.set(otherId, {
      node,
      label: edge.presentation.label,
      outbound,
      claims: new Set([claim]),
      needsReview: edge.reviewStatus === 'unreviewed',
    });
  }
  return [...grouped.values()]
    .map((entry) => ({
      node: entry.node,
      label: entry.label,
      outbound: entry.outbound,
      claims: entry.claims.size,
      needsReview: entry.needsReview,
    }))
    .sort((a, b) => b.node.degree - a.node.degree || a.node.label.localeCompare(b.node.label));
}

/**
 * The item in hand at the centre of an ellipse, with one page of its
 * neighbours around it.
 *
 * Positions are computed for exactly the items on screen rather than read off
 * a whole-graph relaxation, which is the whole point: a dozen placed spokes
 * cannot collide, so every name on this view is readable without zooming. The
 * ellipse is wider than it is tall because the labels are wider than they are
 * tall — a circle wastes the canvas the names actually need.
 */
export function layoutFocusRing(
  snapshot: KnowledgeMapSnapshot,
  entityId: string,
  page = 0,
): FocusLayout | null {
  const centreNode = snapshot.nodes.find((node) => node.id === entityId);
  if (!centreNode) return null;
  const centre = { ...centreNode, x: GLOBAL_MAP_WIDTH / 2, y: GLOBAL_MAP_HEIGHT / 2 };
  const all = focusNeighbors(snapshot, entityId);
  const pages = Math.max(1, Math.ceil(all.length / FOCUS_RING_SIZE));
  // A page beyond the end would render an empty ring with no way back, so it
  // wraps into range instead of trusting the caller's arithmetic.
  const safePage = ((page % pages) + pages) % pages;
  const slice = all.slice(safePage * FOCUS_RING_SIZE, safePage * FOCUS_RING_SIZE + FOCUS_RING_SIZE);
  // Wider than tall because the names are: a circle would spend the canvas on
  // vertical room the labels do not need and starve the horizontal room they
  // do. The flanking spokes still keep ~190 units of margin for their names.
  const radiusX = GLOBAL_MAP_WIDTH * 0.31;
  const radiusY = GLOBAL_MAP_HEIGHT * 0.33;
  const spokes = slice.map((entry, index) => {
    // Start at the top and go clockwise. A single neighbour sits to the right,
    // where its label has the most room to run.
    const angle =
      slice.length === 1 ? 0 : -Math.PI / 2 + (index * (Math.PI * 2)) / Math.max(1, slice.length);
    return {
      ...entry,
      node: {
        ...entry.node,
        x: centre.x + Math.cos(angle) * radiusX,
        y: centre.y + Math.sin(angle) * radiusY,
      },
    };
  });
  return { centre, spokes, total: all.length, page: safePage, pages };
}

/**
 * Where a spoke's name sits relative to its dot, and how much of the name
 * there is room for.
 *
 * `maxChars` is the part that is easy to forget: a name anchored outward from
 * a dot near the right edge runs off the canvas and is clipped by the viewBox,
 * which reads as a rendering fault rather than as an abbreviation. Measuring
 * the room that is actually there lets the label end in an ellipsis instead.
 */
export function spokeLabelAnchor(
  node: { x: number; y: number },
  centre: { x: number; y: number },
  width = GLOBAL_MAP_WIDTH,
): { anchor: 'start' | 'middle' | 'end'; dx: number; dy: number; maxChars: number } {
  const dx = node.x - centre.x;
  const dy = node.y - centre.y;
  const span = Math.max(1, Math.hypot(dx, dy));
  const fit = (room: number) => Math.max(8, Math.min(26, Math.floor(room / 8.6)));
  // Flanking spokes have the width of the canvas beside them; the ones near
  // the top and bottom of the ring do not, so their names go underneath.
  if (Math.abs(dx / span) > 0.5) {
    const offset = dx > 0 ? 22 : -22;
    const room = dx > 0 ? width - (node.x + offset) - 10 : node.x + offset - 10;
    return { anchor: dx > 0 ? 'start' : 'end', dx: offset, dy: 5, maxChars: fit(room) };
  }
  // Centred under (or over) the dot, so the room is whichever side runs out first.
  const room = Math.min(node.x, width - node.x) * 2 - 20;
  return { anchor: 'middle', dx: 0, dy: dy > 0 ? 36 : -28, maxChars: fit(room) };
}

/**
 * The most useful entities to open the map on, grouped by kind.
 *
 * A whole-graph drawing has no front door: every item is the same size and the
 * inspector lands on whichever node the relaxation happened to emit first.
 * This is the front door — the best-connected items of each kind, named, so
 * the first thing the owner sees is a choice rather than a hairball.
 */
export function knowledgeStartingPoints(
  snapshot: KnowledgeMapSnapshot,
  { perKind = 6 }: { perKind?: number } = {},
): Array<{ kind: string; nodes: KnowledgeMapSnapshot['nodes'] }> {
  const byKind = new Map<string, KnowledgeMapSnapshot['nodes']>();
  for (const node of snapshot.nodes) {
    if (node.degree === 0) continue;
    const group = byKind.get(node.kind) ?? [];
    group.push(node);
    byKind.set(node.kind, group);
  }
  return [...byKind.entries()]
    .map(([kind, nodes]) => ({
      kind,
      nodes: [...nodes]
        .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
        .slice(0, perKind),
    }))
    .sort(
      (a, b) =>
        (b.nodes[0]?.degree ?? 0) - (a.nodes[0]?.degree ?? 0) || a.kind.localeCompare(b.kind),
    );
}

/** Roughly how wide a label renders, in viewBox units, at the overview's type size. */
function labelWidth(label: string, fontSize: number): number {
  return label.length * fontSize * 0.53;
}

/**
 * Which overview nodes get to keep their name.
 *
 * Two hundred names in one frame is not a dense map, it is an unreadable one —
 * every label overlaps two others and none of them can be read. So the names
 * are rationed: whatever the owner is looking at first, then the biggest hubs,
 * each placed only if its box lands on empty canvas. The rest stay dots and
 * earn their names by being zoomed in on or selected, which is also what makes
 * zooming feel like it reveals something.
 *
 * Boxes are measured in the *screen* frame rather than world coordinates,
 * because the labels are drawn outside the panned group at a fixed size — a
 * label that shrank with the zoom would be illegible exactly when the map is
 * most crowded.
 */
export function placeOverviewLabels(
  nodes: ReadonlyArray<PositionedKnowledgeNode>,
  viewport: { x: number; y: number; scale: number },
  {
    width = GLOBAL_MAP_WIDTH,
    height = GLOBAL_MAP_HEIGHT,
    max = 34,
    fontSize = 15,
    always = new Set<string>(),
    clip = (label: string) => label,
  }: {
    width?: number;
    height?: number;
    max?: number;
    fontSize?: number;
    always?: ReadonlySet<string>;
    clip?: (label: string) => string;
  } = {},
): {
  labels: Array<{ id: string; text: string; x: number; y: number }>;
  /** Dots inside the frame right now — the denominator the owner can see. */
  visible: number;
} {
  const ranked = [...nodes].sort(
    (a, b) =>
      Number(always.has(b.id)) - Number(always.has(a.id)) ||
      b.degree - a.degree ||
      a.label.localeCompare(b.label),
  );
  const labels: Array<{ id: string; text: string; x: number; y: number }> = [];
  const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  let visible = 0;
  for (const node of ranked) {
    const screenX = node.x * viewport.scale + viewport.x;
    const screenY = node.y * viewport.scale + viewport.y;
    const onScreen = screenX >= 0 && screenX <= width && screenY >= 0 && screenY <= height;
    if (onScreen) visible += 1;
    if (!onScreen) continue;
    if (labels.length >= max && !always.has(node.id)) continue;
    const text = clip(node.label);
    const half = labelWidth(text, fontSize) / 2;
    // The dot itself owns the space above the baseline, so the box starts below it.
    const box = {
      left: screenX - half,
      right: screenX + half,
      top: screenY + fontSize * 0.4,
      bottom: screenY + fontSize * 1.9,
    };
    if (box.left < 2 || box.right > width - 2 || box.bottom > height) continue;
    const collides = boxes.some(
      (other) =>
        box.left < other.right &&
        box.right > other.left &&
        box.top < other.bottom &&
        box.bottom > other.top,
    );
    if (collides) continue;
    boxes.push(box);
    labels.push({ id: node.id, text, x: screenX, y: box.top + fontSize });
  }
  return { labels, visible };
}
