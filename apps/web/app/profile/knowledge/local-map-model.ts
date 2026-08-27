/**
 * Pure canvas model for the interactive local map: layout, viewport math, and
 * expansion merging. Everything here is deterministic and DOM-free so the
 * behaviour the user feels (where nodes land, what a click expands, how zoom
 * moves) is unit-testable without rendering anything.
 *
 * The client component owns event wiring and rendering; every decision it
 * makes goes through one of these functions.
 */

export interface MapEntity {
  id: string;
  label: string;
  kind: string;
}

/**
 * Structurally identical to the application layer's KnowledgeGraphNeighborEdge.
 * Re-declared here so this module stays import-clean: it is bundled into the
 * client map, and a pure presentation module should not need a package import
 * to describe its own input.
 */
export interface MapEdgeInput {
  id: string;
  predicate: string;
  /** True when the queried entity is the subject of the relation. */
  outbound: boolean;
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
  other: MapEntity;
}

export interface CanvasNode extends MapEntity {
  x: number;
  y: number;
  /** 0 = map centre, 1 = its neighbours, 2+ = click-expanded rings. */
  ring: number;
  parentId: string | null;
  /** Set on the "+N more" pager node that stands for a kind's unrevealed neighbours. */
  aggregate?: { kind: string; remaining: number };
}

export interface CanvasEdge {
  id: string;
  predicate: string;
  reviewStatus: string;
  subjectId: string;
  objectId: string;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface Viewport {
  /** Pan offset in viewBox units. */
  x: number;
  y: number;
  scale: number;
}

export const VIEW_W = 760;
export const VIEW_H = 420;
export const CX = VIEW_W / 2;
export const CY = VIEW_H / 2;
export const CENTER_R = 13;
export const NODE_R = 7;
/** Invisible hit disc: 44px diameter keeps nodes operable on touch screens. */
export const HIT_R = 22;
/** Past this many nodes, labels hide until hover/focus — they overlap into mush. */
export const LABEL_LIMIT = 28;
/** One expansion click's budget, mirrored by the server action's clamp. */
export const EXPANSION_LIMIT = 50;
/** Hard stop for the whole canvas; beyond it SVG (and the reader) drowns. */
export const CANVAS_NODE_LIMIT = 400;
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;
/** Pixels of pointer travel before a press becomes a drag instead of a click. */
export const DRAG_THRESHOLD = 4;

export const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

/** The map builds its own entity links — functions cannot cross the server/client boundary as props. */
export function entityHref(entityId: string, query: string, kind: string): string {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (kind) params.set('kind', kind);
  params.set('entity', entityId);
  return `/profile/knowledge?${params.toString()}`;
}

/** The first ring grows its ellipse with degree, so a hub spreads instead of stacking. */
export function ringRadii(count: number): { rx: number; ry: number } {
  const growth = Math.max(1, Math.min(3, 1 + (count - 12) / 60));
  return { rx: 230 * growth, ry: 150 * growth };
}

/**
 * Kind bands get their own arc sectors in this stable order — the order the
 * sidebar's labels already use. Unknown kinds sit behind the known seven.
 */
const KIND_ORDER = ['person', 'organization', 'project', 'place', 'event', 'date', 'topic'];

/** Neighbours of one kind drawn before the "+N more" pager node appears. */
export const KIND_PAGE_SIZE = 12;

function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

interface KindGroup {
  kind: string;
  shown: MapEntity[];
  remaining: number;
}

/** Group neighbours by kind, sorted for stability, paged by `revealed`. */
function groupByKind(others: MapEntity[], revealed: Record<string, number>): KindGroup[] {
  const byKind = new Map<string, MapEntity[]>();
  for (const other of others) {
    const list = byKind.get(other.kind) ?? [];
    list.push(other);
    byKind.set(other.kind, list);
  }
  return [...byKind.entries()]
    .sort((a, b) => kindRank(a[0]) - kindRank(b[0]))
    .map(([kind, items]) => {
      // Label order, not fetch order: paging a kind must not reshuffle it.
      const sorted = [...items].sort((a, b) => a.label.localeCompare(b.label));
      const shown = sorted.slice(0, KIND_PAGE_SIZE * (revealed[kind] ?? 1));
      return { kind, shown, remaining: sorted.length - shown.length };
    });
}

/**
 * The initial canvas: centre plus first hop. Two edges can share a neighbour
 * ("works at" and "advises" the same org), so nodes dedupe by entity id while
 * edges keep their own identity. Self-loops draw as a zero-length line, which
 * is noise — they stay visible in the evidence list instead.
 *
 * Neighbours are banded by kind into equal arc sectors: a hub whose 90 edges
 * mix people, dates, and projects reads as three arcs instead of one pile.
 * Each kind shows a page of KIND_PAGE_SIZE; the remainder collapses into a
 * "+N more" aggregate node that pages its kind in place, so "show everything"
 * is a click per kind rather than an unreadable 150-node star.
 */
export function initialCanvas(
  center: MapEntity,
  edges: MapEdgeInput[],
  revealed: Record<string, number> = {},
): Canvas {
  const seen = new Set<string>([center.id]);
  const uniqueOthers: MapEntity[] = [];
  for (const edge of edges) {
    if (seen.has(edge.other.id)) continue;
    seen.add(edge.other.id);
    uniqueOthers.push(edge.other);
  }
  const groups = groupByKind(uniqueOthers, revealed);
  const renderedTotal = groups.reduce(
    (total, group) => total + group.shown.length + (group.remaining > 0 ? 1 : 0),
    0,
  );
  const { rx, ry } = ringRadii(renderedTotal);
  const nodes: CanvasNode[] = [{ ...center, x: CX, y: CY, ring: 0, parentId: null }];

  const sectorAngle = (2 * Math.PI) / groups.length;
  groups.forEach((group, groupIndex) => {
    const sectorStart = -Math.PI / 2 + groupIndex * sectorAngle;
    // Padding keeps the outermost nodes of adjacent kinds from touching.
    const pad = Math.min(0.18, sectorAngle * 0.2);
    const slots = group.shown.length + (group.remaining > 0 ? 1 : 0);
    const angleFor = (slot: number) =>
      slots === 1
        ? sectorStart + sectorAngle / 2
        : sectorStart + pad + (slot * (sectorAngle - 2 * pad)) / (slots - 1);
    group.shown.forEach((other, index) => {
      const angle = angleFor(index);
      nodes.push({
        ...other,
        x: CX + rx * Math.cos(angle),
        y: CY + ry * Math.sin(angle),
        ring: 1,
        parentId: center.id,
      });
    });
    if (group.remaining > 0) {
      const angle = angleFor(slots - 1);
      nodes.push({
        id: `__more_${group.kind}`,
        label: `+${group.remaining} more`,
        kind: group.kind,
        x: CX + rx * Math.cos(angle),
        y: CY + ry * Math.sin(angle),
        ring: 1,
        parentId: center.id,
        aggregate: { kind: group.kind, remaining: group.remaining },
      });
    }
  });

  const canvasIds = new Set(nodes.map((node) => node.id));
  const canvasEdges: CanvasEdge[] = edges
    // Self-loops draw as a zero-length line, and edges to a paged-out
    // neighbour would be invisible — both stay readable in the evidence list.
    .filter((edge) => edge.other.id !== center.id && canvasIds.has(edge.other.id))
    .map((edge) => ({
      id: edge.id,
      predicate: edge.predicate,
      reviewStatus: edge.reviewStatus,
      subjectId: edge.outbound ? center.id : edge.other.id,
      objectId: edge.outbound ? edge.other.id : center.id,
    }));
  return { nodes, edges: canvasEdges };
}

export interface ExpansionMerge {
  canvas: Canvas;
  /** Entities genuinely new to the canvas — the number worth announcing. */
  added: number;
  /** True when the canvas cap refused part of the expansion. */
  capped: boolean;
}

/**
 * Fold one expansion response into the canvas. New children fan out from the
 * parent on the side away from the canvas centre (or a full ring when the
 * parent IS the centre), so a second hop reads as growing outward rather than
 * collapsing back over the first ring. Edges to already-visible nodes are kept
 * — they are real connections — but only when both ends remain on the canvas.
 */
export function mergeExpansion(
  canvas: Canvas,
  parentId: string,
  edges: MapEdgeInput[],
): ExpansionMerge {
  const parent = canvas.nodes.find((node) => node.id === parentId);
  if (!parent) return { canvas, added: 0, capped: false };

  const onCanvas = new Set(canvas.nodes.map((node) => node.id));
  const fresh: MapEntity[] = [];
  for (const edge of edges) {
    if (edge.other.id === parentId || onCanvas.has(edge.other.id)) continue;
    onCanvas.add(edge.other.id);
    fresh.push(edge.other);
  }

  const capacity = Math.max(0, CANVAS_NODE_LIMIT - canvas.nodes.length);
  const placed = fresh.slice(0, capacity);
  const isCenter = parent.ring === 0;
  const spread = isCenter ? 2 * Math.PI : Math.PI * 1.2;
  // Children grow away from the middle; for the centre itself there is no
  // "away", so they take the same ring layout as a first hop.
  const baseAngle = isCenter ? -Math.PI / 2 : Math.atan2(parent.y - CY, parent.x - CX);
  const startAngle = isCenter ? baseAngle : baseAngle - spread / 2;
  const newNodes: CanvasNode[] = placed.map((other, index) => {
    const angle =
      placed.length === 1
        ? startAngle + spread / 2
        : startAngle + (index * spread) / (placed.length - 1);
    return {
      ...other,
      x: parent.x + 110 * Math.cos(angle),
      y: parent.y + 110 * Math.sin(angle),
      ring: parent.ring + 1,
      parentId,
    };
  });

  const placedIds = new Set(placed.map((node) => node.id));
  const existingEdgeIds = new Set(canvas.edges.map((edge) => edge.id));
  const canvasIds = new Set(canvas.nodes.map((node) => node.id));
  const newEdges: CanvasEdge[] = edges
    .filter((edge) => edge.other.id !== parentId && !existingEdgeIds.has(edge.id))
    .filter((edge) => canvasIds.has(edge.other.id) || placedIds.has(edge.other.id))
    .map((edge) => ({
      id: edge.id,
      predicate: edge.predicate,
      reviewStatus: edge.reviewStatus,
      subjectId: edge.outbound ? parentId : edge.other.id,
      objectId: edge.outbound ? edge.other.id : parentId,
    }));

  return {
    canvas: { nodes: [...canvas.nodes, ...newNodes], edges: [...canvas.edges, ...newEdges] },
    added: placed.length,
    capped: fresh.length > placed.length,
  };
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Zoom keeping the pointer's viewBox point fixed, so the map zooms toward what you point at. */
export function zoomAt(viewport: Viewport, factor: number, px: number, py: number): Viewport {
  const scale = clampScale(viewport.scale * factor);
  if (scale === viewport.scale) return viewport;
  const applied = scale / viewport.scale;
  return { scale, x: px - (px - viewport.x) * applied, y: py - (py - viewport.y) * applied };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

/** Client (screen) coordinates → viewBox coordinates, accounting for the rendered size. */
export function toViewPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  return {
    x: ((clientX - rect.left) * VIEW_W) / rect.width,
    y: ((clientY - rect.top) * VIEW_H) / rect.height,
  };
}

export interface EdgeLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ux: number;
  uy: number;
}

/** A line between two nodes trimmed so it meets neither disc, leaving room for the arrowhead. */
export function edgeLine(
  a: { x: number; y: number },
  b: { x: number; y: number },
  radiusA: number,
  radiusB: number,
): EdgeLine {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  return {
    x1: a.x + ux * (radiusA + 3),
    y1: a.y + uy * (radiusA + 3),
    x2: b.x - ux * (radiusB + 3),
    y2: b.y - uy * (radiusB + 3),
    ux,
    uy,
  };
}

/** Arrowhead polygon points, square to its own edge, at the end the relation points to. */
export function arrowhead(tipX: number, tipY: number, ux: number, uy: number): string {
  const length = 9;
  const half = 3.6;
  const baseX = tipX - ux * length;
  const baseY = tipY - uy * length;
  const px = -uy * half;
  const py = ux * half;
  return [
    `${tipX.toFixed(2)},${tipY.toFixed(2)}`,
    `${(baseX + px).toFixed(2)},${(baseY + py).toFixed(2)}`,
    `${(baseX - px).toFixed(2)},${(baseY - py).toFixed(2)}`,
  ].join(' ');
}
