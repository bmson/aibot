/**
 * Viewport math for the knowledge map: pan, zoom, and framing.
 *
 * The map has one job that decides its whole shape — let the owner see the
 * whole graph, then move in on one item without losing their place. That is
 * entirely a viewport problem, so it lives here: deterministic, DOM-free, and
 * unit-testable without rendering an SVG. The component owns events and marks
 * and routes every viewport decision through one of these functions.
 *
 * A viewport is applied as `translate(x y) scale(scale)`, so a world point p
 * lands at `scale * p + offset`. Every function below preserves that identity.
 */

export interface Viewport {
  /** Pan offset, in viewBox units. */
  x: number;
  y: number;
  scale: number;
}

/**
 * The floor is set by what `frame` needs, not by what stays readable: an
 * overview that cannot reach far enough to hold the whole graph is not an
 * overview. Labels drop out well before this, which is the honest trade — at
 * full extent the map is showing shape, and moving in is what reads names.
 */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Zoom while holding the viewBox point (px, py) still, so the map zooms toward
 * whatever the pointer is over rather than toward the origin.
 */
export function zoomAt(viewport: Viewport, factor: number, px: number, py: number): Viewport {
  const scale = clampScale(viewport.scale * factor);
  if (scale === viewport.scale) return viewport;
  const applied = scale / viewport.scale;
  return { scale, x: px - (px - viewport.x) * applied, y: py - (py - viewport.y) * applied };
}

export function panBy(viewport: Viewport, dx: number, dy: number): Viewport {
  return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

/**
 * A drag measured in CSS pixels, converted to the viewBox units the transform
 * is expressed in. Without this the map slides faster or slower than the
 * pointer at every width but one.
 */
export function screenDelta(
  dx: number,
  dy: number,
  renderedWidth: number,
  viewWidth: number,
): { x: number; y: number } {
  const ratio = renderedWidth > 0 ? viewWidth / renderedWidth : 1;
  return { x: dx * ratio, y: dy * ratio };
}

/** Client (screen) coordinates → viewBox coordinates. */
export function toViewPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } {
  return {
    x: rect.width > 0 ? ((clientX - rect.left) * viewWidth) / rect.width : 0,
    y: rect.height > 0 ? ((clientY - rect.top) * viewHeight) / rect.height : 0,
  };
}

/**
 * The viewport that frames `points` — the whole graph for an overview, or one
 * item and its neighbours when moving in. This is the single mechanic behind
 * both: the caller chooses which points matter and the map flies there.
 *
 * An empty set leaves the viewport at identity rather than dividing by zero,
 * and a single point is framed at `soloScale` since a zero-size box has no
 * scale of its own.
 */
export function frame(
  points: ReadonlyArray<{ x: number; y: number }>,
  viewWidth: number,
  viewHeight: number,
  { padding = 80, soloScale = 1.6 }: { padding?: number; soloScale?: number } = {},
): Viewport {
  if (points.length === 0) return IDENTITY_VIEWPORT;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const usableX = Math.max(1, viewWidth - padding * 2);
  const usableY = Math.max(1, viewHeight - padding * 2);
  // A point (or a perfectly flat row of them) has no extent to fit, so fitting
  // it would divide by zero and blow the scale to MAX. Frame it at a readable
  // fixed zoom instead.
  const fitted =
    spanX < 1 && spanY < 1
      ? soloScale
      : Math.min(spanX < 1 ? soloScale : usableX / spanX, spanY < 1 ? soloScale : usableY / spanY);
  const scale = clampScale(fitted);

  return {
    scale,
    x: viewWidth / 2 - scale * ((minX + maxX) / 2),
    y: viewHeight / 2 - scale * ((minY + maxY) / 2),
  };
}
