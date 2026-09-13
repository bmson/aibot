import { describe, expect, it } from 'vitest';
import {
  clampScale,
  frame,
  IDENTITY_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  screenDelta,
  toViewPoint,
  type Viewport,
  zoomAt,
} from './map-viewport';

const W = 1000;
const H = 640;

/** Where a world point lands on screen under a viewport. */
function project(viewport: Viewport, point: { x: number; y: number }) {
  return {
    x: viewport.scale * point.x + viewport.x,
    y: viewport.scale * point.y + viewport.y,
  };
}

describe('clampScale', () => {
  it('holds the scale inside the readable range', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });
});

describe('zoomAt', () => {
  it('keeps the pointed-at world point under the pointer', () => {
    const before: Viewport = { x: 40, y: -20, scale: 1 };
    // The world point currently under screen position (300, 200).
    const world = { x: (300 - before.x) / before.scale, y: (200 - before.y) / before.scale };

    const after = zoomAt(before, 1.6, 300, 200);

    expect(after.scale).toBeCloseTo(1.6);
    expect(project(after, world).x).toBeCloseTo(300);
    expect(project(after, world).y).toBeCloseTo(200);
  });

  it('returns the same viewport when already clamped', () => {
    const maxed: Viewport = { x: 0, y: 0, scale: MAX_SCALE };
    expect(zoomAt(maxed, 2, 100, 100)).toBe(maxed);
  });
});

describe('panBy', () => {
  it('offsets without touching the scale', () => {
    expect(panBy({ x: 10, y: 10, scale: 2 }, 5, -5)).toEqual({ x: 15, y: 5, scale: 2 });
  });
});

describe('screenDelta', () => {
  it('scales a pixel drag into viewBox units', () => {
    // Rendered at half the viewBox width, so a pixel is worth two units.
    expect(screenDelta(10, -4, W / 2, W)).toEqual({ x: 20, y: -8 });
  });

  it('falls back to 1:1 before the element has been measured', () => {
    expect(screenDelta(10, 10, 0, W)).toEqual({ x: 10, y: 10 });
  });
});

describe('toViewPoint', () => {
  it('maps a client point into viewBox space', () => {
    const rect = { left: 100, top: 50, width: W / 2, height: H / 2 };
    expect(toViewPoint(100, 50, rect, W, H)).toEqual({ x: 0, y: 0 });
    expect(toViewPoint(100 + W / 4, 50 + H / 4, rect, W, H)).toEqual({ x: W / 2, y: H / 2 });
  });

  it('returns the origin for an unmeasured element', () => {
    expect(toViewPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, W, H)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe('frame', () => {
  it('leaves an empty set at identity', () => {
    expect(frame([], W, H)).toBe(IDENTITY_VIEWPORT);
  });

  it('centres the points it frames', () => {
    const points = [
      { x: 200, y: 100 },
      { x: 600, y: 500 },
    ];
    const viewport = frame(points, W, H);
    const centre = project(viewport, { x: 400, y: 300 });

    expect(centre.x).toBeCloseTo(W / 2);
    expect(centre.y).toBeCloseTo(H / 2);
  });

  it('fits the points inside the padding', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 4000, y: 4000 },
    ];
    const viewport = frame(points, W, H, { padding: 80 });

    for (const point of points) {
      const screen = project(viewport, point);
      expect(screen.x).toBeGreaterThanOrEqual(80 - 0.001);
      expect(screen.x).toBeLessThanOrEqual(W - 80 + 0.001);
      expect(screen.y).toBeGreaterThanOrEqual(80 - 0.001);
      expect(screen.y).toBeLessThanOrEqual(H - 80 + 0.001);
    }
  });

  it('frames a lone point at a readable zoom rather than dividing by zero', () => {
    const viewport = frame([{ x: 250, y: 250 }], W, H, { soloScale: 1.6 });

    expect(viewport.scale).toBe(1.6);
    expect(project(viewport, { x: 250, y: 250 }).x).toBeCloseTo(W / 2);
    expect(project(viewport, { x: 250, y: 250 }).y).toBeCloseTo(H / 2);
  });

  it('frames a flat row without collapsing the scale', () => {
    const viewport = frame(
      [
        { x: 100, y: 300 },
        { x: 900, y: 300 },
      ],
      W,
      H,
    );

    expect(viewport.scale).toBeGreaterThan(MIN_SCALE);
    expect(viewport.scale).toBeLessThanOrEqual(MAX_SCALE);
    expect(project(viewport, { x: 500, y: 300 }).y).toBeCloseTo(H / 2);
  });
});
