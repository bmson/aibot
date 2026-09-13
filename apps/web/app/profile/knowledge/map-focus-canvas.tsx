'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  clipNodeLabel,
  entityKindLabel,
  entityKindPaint,
  humanizeEntityLabel,
} from '@/lib/knowledge';
import { btnSm, focusRing } from '@/lib/ui';
import {
  type FocusLayout,
  GLOBAL_MAP_HEIGHT,
  GLOBAL_MAP_WIDTH,
  spokeLabelAnchor,
} from './knowledge-map-model';

const W = GLOBAL_MAP_WIDTH;
const H = GLOBAL_MAP_HEIGHT;

/** Where the spoke stops short of a dot, so the line never runs under it. */
function shorten(
  from: { x: number; y: number },
  to: { x: number; y: number },
  startGap: number,
  endGap: number,
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / distance;
  const uy = dy / distance;
  return {
    x1: from.x + ux * startGap,
    y1: from.y + uy * startGap,
    x2: to.x - ux * endGap,
    y2: to.y - uy * endGap,
  };
}

/**
 * One item at the centre of the canvas with a page of its neighbours around it.
 *
 * This is the map's working view, and it is a different drawing from the
 * overview rather than the overview zoomed in. Nothing here is relaxed against
 * anything else: a dozen positions are computed for a dozen items, so every
 * name is readable, every line is labelled with what it claims, and no pan or
 * zoom is needed to find out what the owner is looking at.
 */
export function MapFocusCanvas({
  layout,
  onOpen,
  onPage,
}: {
  layout: FocusLayout;
  onOpen: (id: string) => void;
  onPage: (page: number) => void;
}) {
  const { centre, spokes, total, page, pages } = layout;
  const centreLabel = humanizeEntityLabel(centre.label);
  const first = page * spokes.length;

  return (
    <div className="min-w-0">
      <div className="relative min-w-0 overflow-hidden rounded-2xl border border-edge bg-sunken">
        {/* A drawing this wide has to be at least this wide. The SVG scales
            with its container, so on a phone the ring's names would render at
            about five pixels — smaller than the browser will let anyone read.
            Below md the same spokes are a list instead, which loses the shape
            and keeps every word. */}
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="hidden h-auto w-full select-none md:block"
          aria-label={`${centreLabel} and ${spokes.length} of its ${total} connected items`}
        >
          <title>{`Connections to ${centreLabel}`}</title>
          <defs>
            <marker
              id="focus-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="18"
              markerHeight="18"
              // Sized in canvas units rather than multiples of the stroke, so the
              // head stays the same readable size if the line weight changes.
              markerUnits="userSpaceOnUse"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 9 5 L 0 9 z" className="fill-muted" />
            </marker>
          </defs>

          {spokes.map((spoke) => {
            // The arrowhead points the way the claim was recorded. An incoming
            // claim keeps its own direction rather than being reworded from the
            // centre's point of view, which would invent a relation nothing
            // stored.
            const line = spoke.outbound
              ? shorten(centre, spoke.node, 34, 20)
              : shorten(spoke.node, centre, 20, 34);
            // Two thirds of the way out rather than halfway. At the midpoint the
            // near-vertical spokes put their phrase on top of the centre's own
            // name, and every phrase crowds into the same small disc around the
            // middle; further out they fan apart with the spokes.
            const along = 0.66;
            const from = spoke.outbound ? { x: line.x1, y: line.y1 } : { x: line.x2, y: line.y2 };
            const to = spoke.outbound ? { x: line.x2, y: line.y2 } : { x: line.x1, y: line.y1 };
            const midX = from.x + (to.x - from.x) * along;
            const midY = from.y + (to.y - from.y) * along;
            return (
              <g key={`edge-${spoke.node.id}`}>
                <line
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  strokeWidth={2}
                  markerEnd="url(#focus-arrow)"
                  className="stroke-edge"
                  strokeDasharray={spoke.needsReview ? '6 5' : undefined}
                />
                <text
                  x={midX}
                  y={midY - 7}
                  textAnchor="middle"
                  className="fill-muted text-[13px]"
                  // The line runs underneath, so the label gets a short break in
                  // it rather than sitting on top of a stroke.
                  paintOrder="stroke"
                  strokeWidth={7}
                  stroke="var(--color-sunken)"
                >
                  {spoke.label}
                  {spoke.claims > 1 ? ` ·${spoke.claims}` : ''}
                </text>
              </g>
            );
          })}

          {spokes.map((spoke) => {
            const place = spokeLabelAnchor(spoke.node, centre, W);
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG cannot contain an HTML button; the group implements button keyboard semantics.
              <g
                key={spoke.node.id}
                role="button"
                tabIndex={0}
                aria-label={`Open ${humanizeEntityLabel(spoke.node.label)}, ${entityKindLabel(spoke.node.kind)}, ${spoke.node.degree} connections`}
                className={`cursor-pointer ${focusRing}`}
                onClick={() => onOpen(spoke.node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(spoke.node.id);
                  }
                }}
              >
                <circle cx={spoke.node.x} cy={spoke.node.y} r={26} fill="transparent" />
                <circle
                  cx={spoke.node.x}
                  cy={spoke.node.y}
                  r={13}
                  strokeWidth={2}
                  className={entityKindPaint(spoke.node.kind).node}
                />
                <text
                  x={spoke.node.x + place.dx}
                  y={spoke.node.y + place.dy}
                  textAnchor={place.anchor}
                  className="fill-strong text-[16px] font-medium"
                  paintOrder="stroke"
                  strokeWidth={5}
                  stroke="var(--color-sunken)"
                >
                  {clipNodeLabel(spoke.node.label, place.maxChars)}
                </text>
              </g>
            );
          })}

          <g>
            <circle
              cx={centre.x}
              cy={centre.y}
              r={30}
              strokeWidth={3}
              className={entityKindPaint(centre.kind).node}
            />
            <text
              x={centre.x}
              y={centre.y + 58}
              textAnchor="middle"
              className="fill-strong text-[19px] font-semibold"
              paintOrder="stroke"
              strokeWidth={6}
              stroke="var(--color-sunken)"
            >
              {clipNodeLabel(centre.label, 30)}
            </text>
          </g>

          {spokes.length === 0 ? (
            <text
              x={centre.x}
              y={centre.y + 92}
              textAnchor="middle"
              className="fill-muted text-[15px]"
            >
              No connections recorded yet
            </text>
          ) : null}
        </svg>

        <div className="md:hidden">
          <p className="border-b border-edge px-4 py-3">
            <span className="text-xs font-medium text-muted">
              {entityKindLabel(centre.kind)} · {total.toLocaleString()}{' '}
              {total === 1 ? 'connection' : 'connections'}
            </span>
            <span className="mt-0.5 block break-words font-display text-lg font-semibold text-strong">
              {centreLabel}
            </span>
          </p>
          {spokes.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">No connections recorded yet</p>
          ) : (
            <ul className="divide-y divide-edge">
              {spokes.map((spoke) => (
                <li key={spoke.node.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(spoke.node.id)}
                    className={`flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left ${focusRing}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`size-2.5 shrink-0 rounded-full ${entityKindPaint(spoke.node.kind).swatch}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium text-strong">
                        {humanizeEntityLabel(spoke.node.label)}
                      </span>
                      <span className="block text-xs text-muted">
                        {/* The arrow carries the recorded direction, exactly as
                            it does on the canvas — the phrase is never reworded
                            to read from the centre's side. */}
                        {spoke.outbound ? '→' : '←'} {spoke.label}
                        {spoke.claims > 1 ? ` · ${spoke.claims} claims` : ''}
                        {spoke.needsReview ? ' · needs review' : ''}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {pages > 1 ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            className={btnSm.outline}
            aria-label="Previous connections"
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft className="size-4" />
          </button>
          <p className="text-xs text-muted" aria-live="polite">
            {first + 1}–{first + spokes.length} of {total.toLocaleString()} connections, most
            connected first
          </p>
          <button
            type="button"
            className={btnSm.outline}
            aria-label="More connections"
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
