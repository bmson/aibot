'use client';

import { Maximize2, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clipNodeLabel, entityKindLabel, entityKindPaint } from '@/lib/knowledge';
import { btnSm, focusRing } from '@/lib/ui';
import {
  GLOBAL_MAP_HEIGHT,
  GLOBAL_MAP_WIDTH,
  type PositionedKnowledgeNode,
  placeOverviewLabels,
} from './knowledge-map-model';
import { frame, screenDelta, toViewPoint, type Viewport, zoomAt } from './map-viewport';

const W = GLOBAL_MAP_WIDTH;
const H = GLOBAL_MAP_HEIGHT;

/** A drag shorter than this is a click on a node, not a pan of the map. */
const DRAG_SLOP = 5;

/**
 * How big a name should look, in real screen pixels, whatever width the canvas
 * happens to render at. The SVG scales its viewBox to fit its column, so a
 * font size written in viewBox units is 16px in a wide layout and 6px in a
 * narrow one — unreadable exactly where space is tightest. Measuring the
 * rendered width and converting back keeps one physical size everywhere, and
 * the collision pass then simply fits fewer names into a smaller canvas, which
 * is the correct answer rather than a shrunken one.
 */
const LABEL_PIXELS = 13;
const MAX_LABEL_UNITS = 30;

export interface OverviewEdge {
  id: string;
  subjectId: string;
  objectId: string;
  unreviewed: boolean;
}

/**
 * The whole graph at once — orientation, not detail.
 *
 * Its one hard problem is that a graph worth having is a graph too big to
 * label. Rather than drawing every name and letting them pile up into a wall
 * of overlapping text, the names are rationed by `placeOverviewLabels`: the
 * selection and the biggest hubs first, each only where it lands on empty
 * canvas. Zooming in frees space and more names appear, which is what makes
 * moving around the map worth doing.
 *
 * Labels are drawn outside the panned group, at a fixed size, positioned from
 * each node's transformed coordinates — inside it they would shrink with the
 * zoom and be least readable exactly where the map is most crowded.
 */
export function MapOverviewCanvas({
  nodes,
  edges,
  selectedId,
  neighborIds,
  onOpen,
  groupCount,
}: {
  nodes: PositionedKnowledgeNode[];
  edges: OverviewEdge[];
  selectedId: string | null;
  neighborIds: ReadonlySet<string>;
  onOpen: (id: string) => void;
  groupCount: number;
}) {
  const [viewport, setViewport] = useState<Viewport>(() => frame(nodes, W, H));
  const framedFor = useRef(nodes);
  if (framedFor.current !== nodes) {
    framedFor.current = nodes;
    setViewport(frame(nodes, W, H));
  }

  const drag = useRef<{ x: number; y: number; width: number; viewport: Viewport } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; viewport: Viewport } | null>(null);
  const suppressClick = useRef(false);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const zoomCentre = (factor: number) =>
    setViewport((current) => zoomAt(current, factor, W / 2, H / 2));
  const fit = useCallback(() => setViewport(frame(nodes, W, H)), [nodes]);

  // Panning fires setViewport on every pointer move. The dots and lines below
  // are memoised without it and only the wrapping transform changes, so a drag
  // re-reconciles the two dozen labels rather than every mark on the map.
  const edgeMarks = useMemo(
    () =>
      edges.map((edge) => {
        const subject = nodeById.get(edge.subjectId);
        const object = nodeById.get(edge.objectId);
        if (!subject || !object) return null;
        const active = selectedId === subject.id || selectedId === object.id;
        return (
          <line
            key={edge.id}
            x1={subject.x}
            y1={subject.y}
            x2={object.x}
            y2={object.y}
            strokeWidth={active ? 2.6 : 1}
            // Not stroke-edge: that token is tuned for a 1px border against a
            // panel, and a field of them on the sunken well reads as an empty
            // canvas. The muted text colour, kept faint, is the quietest line
            // that still draws the shape in both themes.
            className={active ? 'stroke-accent' : 'stroke-muted'}
            opacity={selectedId ? (active ? 0.9 : 0.1) : 0.3}
            strokeDasharray={edge.unreviewed ? '5 4' : undefined}
          />
        );
      }),
    [edges, nodeById, selectedId],
  );

  const nodeMarks = useMemo(
    () =>
      nodes.map((node) => {
        const isSelected = node.id === selectedId;
        const isNeighbor = neighborIds.has(node.id);
        const quiet = selectedId !== null && !isSelected && !isNeighbor;
        // Hubs are the landmarks people navigate by, so degree is worth more
        // visual weight here than it is on the focus ring.
        const radius = isSelected ? 16 : Math.min(14, 5 + Math.sqrt(node.degree) * 2.1);
        return (
          // biome-ignore lint/a11y/useSemanticElements: SVG cannot contain an HTML button; the group implements button keyboard semantics.
          <g
            key={node.id}
            role="button"
            tabIndex={0}
            aria-label={`${node.label}, ${entityKindLabel(node.kind)}, ${node.degree} connections`}
            aria-pressed={isSelected}
            className={`cursor-pointer ${focusRing}`}
            opacity={quiet ? 0.3 : 1}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressClick.current) return;
              onOpen(node.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                // Space scrolls the page otherwise, jumping the map out of view.
                event.preventDefault();
                onOpen(node.id);
              }
            }}
          >
            <circle cx={node.x} cy={node.y} r={20} fill="transparent" />
            <circle
              cx={node.x}
              cy={node.y}
              r={radius}
              className={entityKindPaint(node.kind).node}
              strokeWidth={isSelected ? 4 : 1.8}
            />
          </g>
        );
      }),
    [nodes, selectedId, neighborIds, onOpen],
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [renderedWidth, setRenderedWidth] = useState(W);
  useEffect(() => {
    const element = svgRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setRenderedWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fontSize = Math.min(MAX_LABEL_UNITS, (LABEL_PIXELS * W) / renderedWidth);

  const { labels, visible } = useMemo(
    () =>
      placeOverviewLabels(nodes, viewport, {
        width: W,
        height: H,
        fontSize,
        always: selectedId ? new Set([selectedId]) : new Set<string>(),
        clip: (label) => clipNodeLabel(label, 26),
      }),
    [nodes, viewport, selectedId, fontSize],
  );

  const unnamed = Math.max(0, visible - labels.length);

  return (
    <div
      className="relative min-w-0 overflow-hidden rounded-2xl border border-edge bg-sunken"
      role="application"
      aria-label={`Whole knowledge map: ${nodes.length} connected items across ${groupCount} groups. Drag to pan, scroll or pinch to zoom, and select an item to open its connections.`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the application role owns keyboard pan and zoom as the drag alternative.
      tabIndex={0}
      onKeyDown={(event) => {
        // Deliberately not gated on event.target: keydown bubbles from a
        // focused node, so gating on the container meant every shortcut died
        // the moment someone tabbed onto the graph.
        const keys = ['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        if (keys.includes(event.key)) event.preventDefault();
        if (event.key === '+' || event.key === '=') zoomCentre(1.25);
        if (event.key === '-') zoomCentre(1 / 1.25);
        if (event.key === '0') fit();
        const step = 42;
        if (event.key === 'ArrowLeft') setViewport((v) => ({ ...v, x: v.x + step }));
        if (event.key === 'ArrowRight') setViewport((v) => ({ ...v, x: v.x - step }));
        if (event.key === 'ArrowUp') setViewport((v) => ({ ...v, y: v.y + step }));
        if (event.key === 'ArrowDown') setViewport((v) => ({ ...v, y: v.y - step }));
      }}
    >
      {/* No role="img" here: that flattens the subtree, and the nodes inside
          are focusable buttons. The wrapping role="application" carries the
          name and the counts. */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        onWheel={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const point = toViewPoint(event.clientX, event.clientY, rect, W, H);
          const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
          setViewport((current) => zoomAt(current, factor, point.x, point.y));
        }}
        onPointerDown={(event) => {
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          // Capture is deliberately NOT taken here. Capturing on pointerdown
          // retargets the click that follows to this <svg>, so a node's own
          // onClick never runs and selecting an item silently does nothing. It
          // is taken below, once a gesture has actually begun.
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            if (a && b) pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), viewport };
            drag.current = null;
            return;
          }
          if (event.button !== 0) return;
          suppressClick.current = false;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            width: event.currentTarget.getBoundingClientRect().width,
            viewport,
          };
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

          if (pinch.current && pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            if (!a || !b || pinch.current.distance <= 0) return;
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            suppressClick.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            const rect = event.currentTarget.getBoundingClientRect();
            const midpoint = toViewPoint((a.x + b.x) / 2, (a.y + b.y) / 2, rect, W, H);
            setViewport(
              zoomAt(
                pinch.current.viewport,
                distance / pinch.current.distance,
                midpoint.x,
                midpoint.y,
              ),
            );
            return;
          }

          if (!drag.current) return;
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          if (!suppressClick.current && Math.hypot(dx, dy) < DRAG_SLOP) return;
          suppressClick.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          const delta = screenDelta(dx, dy, drag.current.width, W);
          setViewport({
            ...drag.current.viewport,
            x: drag.current.viewport.x + delta.x,
            y: drag.current.viewport.y + delta.y,
          });
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          if (pointers.current.size === 0) drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          pointers.current.delete(event.pointerId);
          pinch.current = null;
          drag.current = null;
          suppressClick.current = true;
        }}
      >
        <title>Whole knowledge map</title>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {edgeMarks}
          {nodeMarks}
        </g>
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: this layer holds only <text>, nothing focusable — each name is already announced by its node's own aria-label, and reading the layer too would say every name twice. */}
        <g aria-hidden="true" className="pointer-events-none">
          {labels.map((label) => (
            <text
              key={label.id}
              x={label.x}
              y={label.y}
              textAnchor="middle"
              fontSize={fontSize}
              className={label.id === selectedId ? 'fill-accent font-semibold' : 'fill-strong'}
              paintOrder="stroke"
              strokeWidth={4}
              stroke="var(--color-sunken)"
            >
              {label.text}
            </text>
          ))}
        </g>
      </svg>

      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <button
          type="button"
          aria-label="Zoom in"
          className={`${btnSm.outline} bg-raised`}
          onClick={() => zoomCentre(1.25)}
        >
          <Plus className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          className={`${btnSm.outline} bg-raised`}
          onClick={() => zoomCentre(1 / 1.25)}
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Fit the whole graph"
          title="Fit the whole graph"
          className={`${btnSm.outline} bg-raised`}
          onClick={fit}
        >
          <Maximize2 className="size-4" />
        </button>
      </div>

      {unnamed > 0 ? (
        <p
          className="absolute bottom-3 left-3 rounded-full bg-raised/90 px-3 py-1 text-xs text-muted"
          aria-live="polite"
        >
          {unnamed.toLocaleString()} of the {visible.toLocaleString()} items in view are too close
          together to name — zoom in, or select one
        </p>
      ) : null}
    </div>
  );
}
