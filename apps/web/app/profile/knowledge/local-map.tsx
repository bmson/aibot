'use client';

import { ArrowRight, Minus, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadKnowledgeNeighborhood } from '@/app/profile/knowledge/actions';
import {
  arrowhead,
  type CanvasNode,
  CENTER_R,
  CX,
  CY,
  DRAG_THRESHOLD,
  EXPANSION_LIMIT,
  edgeLine,
  entityHref,
  HIT_R,
  INITIAL_VIEWPORT,
  initialCanvas,
  LABEL_LIMIT,
  type MapEdgeInput,
  type MapEntity,
  mergeExpansion,
  NODE_R,
  panBy,
  toViewPoint,
  VIEW_H,
  VIEW_W,
  type Viewport,
  zoomAt,
} from '@/app/profile/knowledge/local-map-model';
import {
  clipNodeLabel,
  entityKindLabel,
  entityKindPaint,
  humanizePredicate,
} from '@/lib/knowledge';
import { btnSm, focusRing } from '@/lib/ui';

/**
 * The interactive local map: pan, zoom, select a neighbour to act on it (open
 * re-centres the page; expand grows its connections in place), and page crowded
 * kinds with their "+N more" pill.
 *
 * Node actions live in one floating toolbar rather than a per-node badge: a
 * hub has dozens of neighbours, and a button on each was visual noise. The
 * toolbar's controls are real HTML elements with full-size touch targets —
 * SVG nodes stay links, and the drawing stays quiet until you select something.
 *
 * The first hop arrives as server-rendered props; expansion goes through a
 * server action. Rendering stays SVG (no charting dependency): layout is
 * deterministic trigonometry from local-map-model, so the drawing is
 * snapshot-stable, keyboard-navigable, and never animates under
 * prefers-reduced-motion.
 */

const WHEEL_ZOOM_IN = 1.12;
const WHEEL_ZOOM_OUT = 1 / WHEEL_ZOOM_IN;
const KEY_PAN = 40;
const KEY_ZOOM = 1.25;

interface ExpansionData {
  edges: MapEdgeInput[];
  total: number;
}

export function LocalMap({
  selected,
  initialEdges,
  totalEdges,
  query,
  kind,
  view,
}: {
  selected: MapEntity;
  initialEdges: MapEdgeInput[];
  totalEdges: number;
  query: string;
  kind: string;
  /** Preserved in node links so opening a neighbour stays in the map view. */
  view?: string;
}) {
  /** Kind → pages revealed so far (1 = the first KIND_PAGE_SIZE). */
  const [revealed, setRevealed] = useState<Record<string, number>>({});
  /** Node id → its fetched second hop. Canvas derives from this, so a reveal re-layout keeps expansions. */
  const [expandedData, setExpandedData] = useState<Record<string, ExpansionData>>({});
  /** The canvas node selected for the action toolbar. Not the page's entity. */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: Viewport;
    dragging: boolean;
  } | null>(null);

  // Server navigation or a revalidation (confirm/mark-stale) hands down new
  // props; the canvas resets to match rather than showing stale expansions.
  // Adjusting state during render is the React-sanctioned reset pattern and
  // avoids an effect that would paint the stale frame first.
  const propsKey = `${selected.id}|${initialEdges.map((edge) => `${edge.id}:${edge.reviewStatus}`).join(',')}`;
  const [seenPropsKey, setSeenPropsKey] = useState(propsKey);
  if (seenPropsKey !== propsKey) {
    setSeenPropsKey(propsKey);
    setRevealed({});
    setExpandedData({});
    setSelectedNodeId(null);
    setViewport(INITIAL_VIEWPORT);
    setPendingId(null);
    setActiveId(null);
  }

  const canvas = useMemo(() => {
    let next = initialCanvas(selected, initialEdges, revealed);
    for (const [parentId, data] of Object.entries(expandedData)) {
      next = mergeExpansion(next, parentId, data.edges).canvas;
    }
    return next;
  }, [selected, initialEdges, revealed, expandedData]);

  const nodeById = new Map(canvas.nodes.map((node) => [node.id, node]));
  const realNodes = canvas.nodes.filter((node) => !node.aggregate);
  const showAllLabels = realNodes.length <= LABEL_LIMIT;
  const toolbarNode = selectedNodeId
    ? canvas.nodes.find((node) => node.id === selectedNodeId && !node.aggregate)
    : undefined;

  const hrefFor = (entityId: string) => entityHref(entityId, query, kind, view);

  const handleReveal = (kindKey: string) => {
    setRevealed((previous) => ({ ...previous, [kindKey]: (previous[kindKey] ?? 1) + 1 }));
    setAnnounce(`Showing more ${entityKindLabel(kindKey).toLocaleLowerCase()} connections.`);
  };

  const handleExpand = async (node: CanvasNode) => {
    if (pendingId) return;
    setPendingId(node.id);
    try {
      const result = await loadKnowledgeNeighborhood(node.id, EXPANSION_LIMIT);
      const merged = mergeExpansion(canvas, node.id, result.edges);
      setExpandedData((previous) => ({
        ...previous,
        [node.id]: { edges: result.edges, total: result.total },
      }));
      setAnnounce(
        merged.added > 0
          ? `Showing ${merged.added} more connection${merged.added === 1 ? '' : 's'} around ${node.label}.${merged.capped ? ' The map is full; open a node to keep exploring.' : ''}`
          : `No further connections around ${node.label}.`,
      );
    } catch {
      setAnnounce(`Could not load connections around ${node.label}. Try again.`);
    } finally {
      setPendingId(null);
    }
  };

  // ── Pan/zoom wiring ──────────────────────────────────────────────────────
  // Pointer capture starts only once the drag threshold trips, so a plain
  // press on a node still reaches the anchor as a click.

  const handlePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: viewport,
      dragging: false,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.dragging) {
      drag.dragging = true;
      svgRef.current?.setPointerCapture(event.pointerId);
    }
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleX = VIEW_W / rect.width;
    const scaleY = VIEW_H / rect.height;
    setViewport(panBy(drag.origin, dx * scaleX, dy * scaleY));
  };

  const handlePointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.dragging) svgRef.current?.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setSelectedNodeId(null);
      return;
    }
    const panKeys: Record<string, [number, number]> = {
      ArrowLeft: [KEY_PAN, 0],
      ArrowRight: [-KEY_PAN, 0],
      ArrowUp: [0, KEY_PAN],
      ArrowDown: [0, -KEY_PAN],
    };
    const pan = panKeys[event.key];
    if (pan) {
      event.preventDefault();
      setViewport((current) => panBy(current, pan[0], pan[1]));
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setViewport((current) => zoomAt(current, KEY_ZOOM, VIEW_W / 2, VIEW_H / 2));
    } else if (event.key === '-') {
      event.preventDefault();
      setViewport((current) => zoomAt(current, 1 / KEY_ZOOM, VIEW_W / 2, VIEW_H / 2));
    } else if (event.key === '0') {
      event.preventDefault();
      setViewport(INITIAL_VIEWPORT);
    }
  };

  // React attaches wheel listeners passively, which cannot preventDefault —
  // the page would scroll while the map zooms. A native non-passive listener
  // is the only way to keep wheel-zoom inside the map region.
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const point = toViewPoint(event.clientX, event.clientY, rect);
      setViewport((current) =>
        zoomAt(current, event.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT, point.x, point.y),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const zoomButtonClass = `mobile-touch-target inline-flex size-9 items-center justify-center rounded-lg border border-edge bg-raised/95 text-muted motion-safe:transition-colors hover:text-strong ${focusRing}`;

  const nodeLabelVisible = (node: CanvasNode) =>
    showAllLabels ||
    node.id === activeId ||
    node.id === selectedNodeId ||
    Boolean(expandedData[node.id]) ||
    Boolean(node.aggregate);

  const description = canvas.edges
    .map((edge) => {
      const subject = nodeById.get(edge.subjectId);
      const object = nodeById.get(edge.objectId);
      if (!subject || !object) return '';
      return `${subject.label} ${humanizePredicate(edge.predicate)} ${object.label}`;
    })
    .filter(Boolean)
    .join('; ');

  return (
    <div>
      <div
        className="relative overflow-hidden rounded-xl border border-edge bg-[radial-gradient(circle_at_center,rgba(81,143,106,0.12),transparent_48%)]"
        // A pan/zoom canvas with its own key map is one of the few legitimate
        // application roles: arrow-key panning is the WCAG 2.5.7 keyboard
        // alternative to drag-pan, and every control inside stays Tab-operable.
        role="application"
        aria-label="Interactive map viewport. Select a node to act on it. Drag to pan; use arrow keys to pan, plus and minus to zoom, zero to reset, escape to clear the selection."
        // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow-key panning is the keyboard alternative to drag-pan, so the widget must be in the tab order.
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {realNodes.length === 1 ? (
          <p className="p-2 py-10 text-center text-sm text-muted sm:p-4">
            No active connections to draw yet.
          </p>
        ) : (
          // touch-action:none lets a finger drag pan the map instead of fighting
          // the page scroll; the map's height keeps the rest of the page reachable.
          // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard equivalent of a background press is Escape on the wrapping viewport's keydown.
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            className="h-auto w-full touch-none select-none"
            role="img"
            aria-labelledby="local-map-title local-map-desc"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onClick={(event) => {
              // A press on empty canvas clears the selection; node clicks stop
              // at their own handlers, so reaching here means background.
              if (!(event.target as Element).closest('a, [role="button"]')) {
                setSelectedNodeId(null);
              }
            }}
          >
            <title id="local-map-title">{`Connections around ${selected.label}`}</title>
            <desc id="local-map-desc">{description}</desc>

            <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
              {canvas.edges.map((edge) => {
                const subject = nodeById.get(edge.subjectId);
                const object = nodeById.get(edge.objectId);
                if (!subject || !object) return null;
                const confirmed = edge.reviewStatus === 'confirmed';
                const line = edgeLine(
                  subject,
                  object,
                  subject.ring === 0 ? CENTER_R : NODE_R,
                  object.ring === 0 ? CENTER_R : NODE_R,
                );
                return (
                  <g key={edge.id}>
                    <line
                      x1={line.x1}
                      y1={line.y1}
                      x2={line.x2}
                      y2={line.y2}
                      strokeWidth={1.5}
                      strokeDasharray={confirmed ? undefined : '4 3'}
                      className={
                        confirmed
                          ? 'stroke-accent/70'
                          : 'stroke-amber-500/80 dark:stroke-amber-400/80'
                      }
                    />
                    <polygon
                      points={arrowhead(line.x2, line.y2, line.ux, line.uy)}
                      className={
                        confirmed ? 'fill-accent/70' : 'fill-amber-500/80 dark:fill-amber-400/80'
                      }
                    />
                  </g>
                );
              })}

              {canvas.nodes.map((node) => {
                if (node.ring === 0) return null;
                const aggregate = node.aggregate;
                if (aggregate) {
                  // The kind pager: a pill, not a node, so it can never be
                  // mistaken for an entity.
                  const pillWidth = Math.max(56, node.label.length * 6.4 + 18);
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a <button> cannot exist inside SVG; the g carries the button role, keyboard activation, and an accessible name.
                    <g
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Show more ${entityKindLabel(node.kind).toLocaleLowerCase()} connections (${aggregate.remaining} not shown)`}
                      className={`cursor-pointer ${focusRing}`}
                      onClick={() => handleReveal(aggregate.kind)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleReveal(aggregate.kind);
                        }
                      }}
                    >
                      <circle cx={node.x} cy={node.y} r={HIT_R} fill="transparent" />
                      <rect
                        x={node.x - pillWidth / 2}
                        y={node.y - 11}
                        width={pillWidth}
                        height={22}
                        rx={11}
                        strokeWidth={1.5}
                        className="fill-raised stroke-edge"
                      />
                      <text
                        x={node.x}
                        y={node.y + 3.5}
                        textAnchor="middle"
                        className="fill-muted text-[10.5px] font-medium"
                      >
                        {node.label}
                      </text>
                    </g>
                  );
                }

                const paint = entityKindPaint(node.kind);
                const expansion = expandedData[node.id];
                const overflow = expansion
                  ? Math.max(0, expansion.total - expansion.edges.length)
                  : 0;
                const isSelected = node.id === selectedNodeId;
                const anchorLeft = node.x > CX + 40;
                const labelX = anchorLeft ? node.x - (NODE_R + 6) : node.x + NODE_R + 6;
                return (
                  <g key={node.id}>
                    <a
                      href={hrefFor(node.id)}
                      className="group"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={(event) => {
                        // Selection, not navigation: the toolbar carries the
                        // "open" action. The href stays for keyboard focus,
                        // screen readers, and open-in-new-tab.
                        event.preventDefault();
                        setSelectedNodeId(node.id);
                      }}
                      onMouseEnter={() => setActiveId(node.id)}
                      onMouseLeave={() => setActiveId(null)}
                      onFocus={() => setActiveId(node.id)}
                      onBlur={() => setActiveId(null)}
                    >
                      <title>
                        {`${node.label} — ${entityKindLabel(node.kind)}. Select to open or expand it.`}
                      </title>
                      {/* Invisible 44px hit disc over the visible node. */}
                      <circle cx={node.x} cy={node.y} r={HIT_R} fill="transparent" />
                      {isSelected ? (
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={NODE_R + 4.5}
                          strokeWidth={2}
                          className="fill-none stroke-accent"
                        />
                      ) : null}
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={NODE_R}
                        strokeWidth={2}
                        className={`${paint.node} group-focus-visible:stroke-zinc-900 group-focus-visible:stroke-[3] dark:group-focus-visible:stroke-white`}
                      />
                      {nodeLabelVisible(node) ? (
                        <text
                          x={labelX}
                          y={node.y + 1}
                          textAnchor={anchorLeft ? 'end' : 'start'}
                          className={`text-[12px] ${isSelected ? 'fill-strong font-semibold' : 'fill-strong font-medium'}`}
                        >
                          {clipNodeLabel(node.label, 22)}
                        </text>
                      ) : null}
                      {overflow > 0 ? (
                        <text
                          x={labelX}
                          y={node.y + 14}
                          textAnchor={anchorLeft ? 'end' : 'start'}
                          className="fill-muted text-[9.5px]"
                        >
                          {`+${overflow} more — open to explore`}
                        </text>
                      ) : null}
                    </a>
                  </g>
                );
              })}

              <circle
                cx={CX}
                cy={CY}
                r={CENTER_R}
                strokeWidth={2.5}
                className={entityKindPaint(selected.kind).node}
              />
              <text
                x={CX}
                y={CY - CENTER_R - 10}
                textAnchor="middle"
                className="fill-strong text-[13px] font-semibold"
              >
                {clipNodeLabel(selected.label, 28)}
              </text>
              <text
                x={CX}
                y={CY + CENTER_R + 16}
                textAnchor="middle"
                className="fill-muted text-[9.5px] tracking-[0.08em] uppercase"
              >
                {entityKindLabel(selected.kind)}
              </text>
            </g>
          </svg>
        )}

        <div className="absolute top-2 right-2 flex flex-col gap-1">
          <button
            type="button"
            aria-label="Zoom in"
            className={zoomButtonClass}
            onClick={() =>
              setViewport((current) => zoomAt(current, KEY_ZOOM, VIEW_W / 2, VIEW_H / 2))
            }
          >
            <Plus className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            className={zoomButtonClass}
            onClick={() =>
              setViewport((current) => zoomAt(current, 1 / KEY_ZOOM, VIEW_W / 2, VIEW_H / 2))
            }
          >
            <Minus className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Reset view"
            className={zoomButtonClass}
            onClick={() => setViewport(INITIAL_VIEWPORT)}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
          </button>
        </div>

        {/* The one place node actions live. Selecting a node floats this bar;
            its controls are real HTML with full-size targets, which a per-node
            SVG badge could never be. */}
        {toolbarNode ? (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 flex justify-center">
            <div className="pointer-events-auto flex min-w-0 max-w-full items-center gap-2 rounded-full bg-raised/95 py-1.5 pr-1.5 pl-3 ring-1 ring-edge backdrop-blur-sm">
              <span
                aria-hidden="true"
                className={`inline-block size-2 shrink-0 rounded-full ${entityKindPaint(toolbarNode.kind).swatch}`}
              />
              <span className="min-w-0 truncate text-sm font-medium text-strong">
                {toolbarNode.label}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {entityKindLabel(toolbarNode.kind)}
              </span>
              {expandedData[toolbarNode.id] ? (
                <span className="shrink-0 px-2 text-xs text-muted">Expanded</span>
              ) : (
                <button
                  type="button"
                  disabled={pendingId !== null}
                  onClick={() => void handleExpand(toolbarNode)}
                  className={btnSm.outline}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  {pendingId === toolbarNode.id ? 'Loading…' : 'Expand'}
                </button>
              )}
              <a href={hrefFor(toolbarNode.id)} className={btnSm.primary}>
                Open
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </a>
            </div>
          </div>
        ) : null}

        <div aria-live="polite" role="status" className="sr-only">
          {announce}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {[...new Set(realNodes.map((node) => node.kind))].map((nodeKind) => (
          <span key={nodeKind} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block size-2 rounded-full ${entityKindPaint(nodeKind).swatch}`}
            />
            {entityKindLabel(nodeKind)}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-px w-4 border-t-2 border-dashed border-amber-500 dark:border-amber-400"
          />
          Needs review
        </span>
      </div>

      {/* The drawing's content as a navigable list — the equivalent for anyone
          not reading the SVG, and the touch-friendly path on small screens. */}
      <ul className="sr-only">
        {realNodes
          .filter((node) => node.ring > 0)
          .map((node) => {
            const connecting = canvas.edges.filter(
              (edge) =>
                (edge.subjectId === node.id || edge.objectId === node.id) &&
                (edge.subjectId === selected.id || edge.objectId === selected.id),
            );
            return (
              <li key={node.id}>
                <a href={hrefFor(node.id)}>
                  {`${node.label} (${entityKindLabel(node.kind)})${
                    connecting.length > 0
                      ? ` — ${connecting
                          .map(
                            (edge) =>
                              `${edge.subjectId === node.id ? 'outgoing' : 'incoming'} ${humanizePredicate(edge.predicate)}${edge.reviewStatus === 'confirmed' ? '' : ', needs review'}`,
                          )
                          .join('; ')}`
                      : ''
                  }`}
                </a>
              </li>
            );
          })}
      </ul>

      {/* Three distinct numbers can honestly differ here: what is drawn
          (kind-paged), what is loaded (server page), and the true degree from
          a count query. Conflating drawn with total is the bug the true-total
          queries exist to fix. */}
      {totalEdges > canvas.edges.length ? (
        <p className="mt-2 text-xs text-muted">
          {`Showing ${canvas.edges.length.toLocaleString()} of ${totalEdges.toLocaleString()} active connections.`}
          {initialEdges.length > canvas.edges.length
            ? ' More are already loaded — page a kind with its “more” pill.'
            : ` The first ${initialEdges.length.toLocaleString()} are loaded; open a neighbour to keep exploring.`}
        </p>
      ) : null}
    </div>
  );
}
