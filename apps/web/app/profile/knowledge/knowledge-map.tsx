'use client';

import type { KnowledgeMapSnapshot } from '@assistant/application';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  GLOBAL_MAP_HEIGHT,
  GLOBAL_MAP_WIDTH,
  knowledgeConnections,
  layoutKnowledgeMap,
} from '@/app/profile/knowledge/knowledge-map-model';
import {
  frame,
  screenDelta,
  toViewPoint,
  type Viewport,
  zoomAt,
} from '@/app/profile/knowledge/map-viewport';
import { SourceImpactForget } from '@/app/profile/knowledge/source-impact-forget';
import { entityKindLabel, entityKindPaint } from '@/lib/knowledge';
import { btnSm, focusRing, inputClass } from '@/lib/ui';
import { ConnectionTree } from './connection-tree';
import { RemoveConnection } from './remove-connection';

const W = GLOBAL_MAP_WIDTH;
const H = GLOBAL_MAP_HEIGHT;

/**
 * Labels are the first thing to go when the map is showing shape rather than
 * detail. Above this scale there is room to read them; below it the selected
 * item and its neighbours keep theirs and everything else goes quiet.
 */
const LABEL_SCALE = 0.9;

/** A drag shorter than this is a click on a node, not a pan of the map. */
const DRAG_SLOP = 5;

export function KnowledgeMap({
  snapshot,
  initialSelectedId,
}: {
  snapshot: KnowledgeMapSnapshot;
  initialSelectedId?: string;
}) {
  const nodes = useMemo(() => layoutKnowledgeMap(snapshot), [snapshot]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const [selectedId, setSelectedId] = useState(initialSelectedId ?? nodes[0]?.id ?? null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'map' | 'list'>('map');
  const [viewport, setViewport] = useState<Viewport>(() => frame(nodes, W, H));

  // Filters arrive as search params, so this component re-renders in place with
  // a new snapshot rather than remounting. Re-framing on the new node set is
  // what makes a filter feel like it did something; without it the map holds a
  // viewport aimed at wherever the old graph happened to be.
  const framedFor = useRef(nodes);
  if (framedFor.current !== nodes) {
    framedFor.current = nodes;
    setViewport(frame(nodes, W, H));
  }

  const drag = useRef<{ x: number; y: number; width: number; viewport: Viewport } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; viewport: Viewport } | null>(null);
  const suppressClick = useRef(false);

  // Falling back to the first node keeps the inspector populated; reading state
  // alone left the whole panel blank whenever the previous selection filtered out.
  const selected = (selectedId ? nodeById.get(selectedId) : undefined) ?? nodes[0];
  const activeId = selected?.id ?? null;

  const selectedEdges = useMemo(
    () =>
      selected
        ? snapshot.edges.filter(
            (edge) => edge.subjectId === selected.id || edge.objectId === selected.id,
          )
        : [],
    [snapshot.edges, selected],
  );
  const connections = useMemo(
    () => (selected ? knowledgeConnections(snapshot, selected.id) : []),
    [snapshot, selected],
  );
  const neighbors = useMemo(
    () => new Set(selectedEdges.flatMap((edge) => [edge.subjectId, edge.objectId])),
    [selectedEdges],
  );

  /** The whole graph, framed. The map's home position. */
  const showEverything = useCallback(() => setViewport(frame(nodes, W, H)), [nodes]);

  /**
   * Select an item and move in on it — the one gesture that takes the map from
   * overview to detail. Framing the item *and its neighbours* rather than the
   * item alone is what keeps the move legible: you arrive seeing what it is
   * connected to, which is the thing you came to look at.
   */
  const moveIn = useCallback(
    (id: string) => {
      setSelectedId(id);
      const node = nodeById.get(id);
      if (!node) return;
      const around = snapshot.edges
        .filter((edge) => edge.subjectId === id || edge.objectId === id)
        .flatMap((edge) => [nodeById.get(edge.subjectId), nodeById.get(edge.objectId)])
        .filter((each): each is NonNullable<typeof each> => !!each);
      setViewport(frame([node, ...around], W, H, { padding: 110, soloScale: 1.8 }));
    },
    [nodeById, snapshot.edges],
  );

  const zoomCentre = (factor: number) =>
    setViewport((current) => zoomAt(current, factor, W / 2, H / 2));

  const showLabels = viewport.scale >= LABEL_SCALE;

  // Panning fires setViewport on every pointer move, and only the wrapping <g>
  // transform changes with it. Memoising the marks keeps a drag from
  // re-reconciling every node and edge on the map, sixty times a second.
  const edgeMarks = useMemo(
    () =>
      snapshot.edges.map((edge) => {
        const subject = nodeById.get(edge.subjectId);
        const object = nodeById.get(edge.objectId);
        if (!subject || !object) return null;
        const active = activeId === subject.id || activeId === object.id;
        return (
          <line
            key={edge.id}
            x1={subject.x}
            y1={subject.y}
            x2={object.x}
            y2={object.y}
            strokeWidth={active ? 2.6 : 1.2}
            className={active ? 'stroke-accent' : 'stroke-edge'}
            opacity={activeId && !active ? 0.2 : 0.7}
            strokeDasharray={edge.reviewStatus === 'unreviewed' ? '5 4' : undefined}
          />
        );
      }),
    [snapshot.edges, nodeById, activeId],
  );

  const nodeMarks = useMemo(
    () =>
      nodes.map((node) => {
        const isSelected = node.id === activeId;
        const isNeighbor = neighbors.has(node.id);
        const radius = Math.min(15, 7 + Math.sqrt(node.degree) * 2);
        return (
          // biome-ignore lint/a11y/useSemanticElements: SVG cannot contain an HTML button; the group implements button keyboard semantics.
          <g
            key={node.id}
            role="button"
            tabIndex={0}
            aria-label={`${node.label}, ${entityKindLabel(node.kind)}, ${node.degree} connections`}
            aria-pressed={isSelected}
            className={`cursor-pointer ${focusRing}`}
            opacity={activeId && !isSelected && !isNeighbor ? 0.45 : 1}
            onClick={(event) => {
              event.stopPropagation();
              if (suppressClick.current) return;
              moveIn(node.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                // Space scrolls the page otherwise, jumping the map out of view.
                event.preventDefault();
                moveIn(node.id);
              }
            }}
          >
            <circle cx={node.x} cy={node.y} r={22} fill="transparent" />
            <circle
              cx={node.x}
              cy={node.y}
              r={radius}
              className={entityKindPaint(node.kind).node}
              strokeWidth={isSelected ? 4 : 2}
            />
            {showLabels || isSelected || isNeighbor ? (
              <text
                x={node.x}
                y={node.y + radius + 14}
                textAnchor="middle"
                className="fill-strong text-[16px] font-medium"
              >
                {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
              </text>
            ) : null}
          </g>
        );
      }),
    [nodes, activeId, neighbors, showLabels, moveIn],
  );

  if (nodes.length === 0) {
    return (
      <div className="rounded-2xl border border-edge bg-sunken/30 px-6 py-16 text-center">
        <p className="font-medium text-strong">No connected knowledge to map</p>
        <p className="mt-1 text-sm text-muted">
          Add or organize source memories to build the first connection.
        </p>
      </div>
    );
  }

  const browseNodes = nodes.filter((node) =>
    node.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <fieldset className="flex flex-wrap items-center gap-2" aria-label="Connection view">
          <button
            type="button"
            aria-pressed={view === 'map'}
            className={`${btnSm.outline} ${view === 'map' ? 'border-accent bg-accent/10 text-accent' : ''}`}
            onClick={() => setView('map')}
          >
            Map
          </button>
          <button
            type="button"
            aria-pressed={view === 'list'}
            className={`${btnSm.outline} ${view === 'list' ? 'border-accent bg-accent/10 text-accent' : ''}`}
            onClick={() => setView('list')}
          >
            List
          </button>
        </fieldset>
        <p className="text-xs text-muted">Solid: confirmed · Dashed: needs review</p>
      </div>

      {view === 'list' && selected ? <ConnectionTree key={selected.id} root={selected} /> : null}

      <div
        className={`${view === 'list' ? 'hidden' : 'grid'} min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]`}
      >
        <div className="min-w-0">
          <div
            className="relative min-w-0 overflow-hidden rounded-2xl border border-edge bg-sunken/20"
            role="application"
            aria-label="Knowledge map. Drag to pan, pinch or scroll to zoom, and select an item to move in on its connections."
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the application role owns keyboard pan and zoom as the drag alternative.
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              const keys = ['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
              if (keys.includes(event.key)) event.preventDefault();
              if (event.key === '+' || event.key === '=') zoomCentre(1.25);
              if (event.key === '-') zoomCentre(1 / 1.25);
              if (event.key === '0') showEverything();
              const step = 42;
              if (event.key === 'ArrowLeft') setViewport((v) => ({ ...v, x: v.x + step }));
              if (event.key === 'ArrowRight') setViewport((v) => ({ ...v, x: v.x - step }));
              if (event.key === 'ArrowUp') setViewport((v) => ({ ...v, y: v.y + step }));
              if (event.key === 'ArrowDown') setViewport((v) => ({ ...v, y: v.y - step }));
            }}
          >
            <svg
              viewBox={`0 0 ${W} ${H}`}
              className="h-auto w-full touch-none select-none"
              role="img"
              aria-label={`${nodes.length} connected knowledge items across ${snapshot.components.length} groups`}
              onWheel={(event) => {
                // Trackpad and wheel both arrive here; anchoring on the pointer
                // is what makes zoom feel like moving in on a thing rather than
                // rescaling a picture.
                const rect = event.currentTarget.getBoundingClientRect();
                const point = toViewPoint(event.clientX, event.clientY, rect, W, H);
                const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
                setViewport((current) => zoomAt(current, factor, point.x, point.y));
              }}
              onPointerDown={(event) => {
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                event.currentTarget.setPointerCapture(event.pointerId);
                if (pointers.current.size === 2) {
                  const [a, b] = [...pointers.current.values()];
                  pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), viewport };
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
                  const distance = Math.hypot(a.x - b.x, a.y - b.y);
                  if (pinch.current.distance <= 0) return;
                  suppressClick.current = true;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const midpoint = toViewPoint((a.x + b.x) / 2, (a.y + b.y) / 2, rect, W, H);
                  const factor = distance / pinch.current.distance;
                  setViewport(zoomAt(pinch.current.viewport, factor, midpoint.x, midpoint.y));
                  return;
                }

                if (!drag.current) return;
                const dx = event.clientX - drag.current.x;
                const dy = event.clientY - drag.current.y;
                if (!suppressClick.current && Math.hypot(dx, dy) < DRAG_SLOP) return;
                suppressClick.current = true;
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
              <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
                {edgeMarks}
                {nodeMarks}
              </g>
            </svg>

            <div className="absolute top-3 right-3 flex flex-col gap-1">
              <button
                type="button"
                aria-label="Zoom in"
                className={btnSm.outline}
                onClick={() => zoomCentre(1.25)}
              >
                <Plus className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                className={btnSm.outline}
                onClick={() => zoomCentre(1 / 1.25)}
              >
                <Minus className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Show everything"
                title="Show everything"
                className={btnSm.outline}
                onClick={showEverything}
              >
                <Maximize2 className="size-4" />
              </button>
            </div>

            {selected ? (
              <button
                type="button"
                onClick={showEverything}
                className={`${btnSm.outline} absolute bottom-3 left-3 bg-raised`}
              >
                Show everything
              </button>
            ) : null}
          </div>

          <label className="mt-4 block text-sm font-medium text-strong">
            Find an item in this view
            <input
              className={`${inputClass} mt-2 w-full`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Person, project, place…"
            />
          </label>
          <fieldset
            className="mt-2 flex max-h-40 flex-wrap gap-2 overflow-y-auto"
            aria-label="Knowledge items"
          >
            {browseNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                aria-pressed={node.id === activeId}
                onClick={() => moveIn(node.id)}
                className={`${btnSm.outline} min-h-11 max-w-full ${node.id === activeId ? 'border-accent bg-accent/10 text-accent' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${entityKindPaint(node.kind).swatch}`}
                />
                <span className="truncate">{node.label}</span>
              </button>
            ))}
            {browseNodes.length === 0 ? (
              <p className="py-3 text-sm text-muted">
                No items match in this view. Change the map filters to search the rest of your
                knowledge.
              </p>
            ) : null}
          </fieldset>
        </div>

        <aside
          className="min-w-0 rounded-2xl border border-edge bg-raised p-4 sm:p-5"
          aria-label="Selected knowledge item"
        >
          {selected ? (
            <>
              <p className="text-xs font-medium text-muted">{entityKindLabel(selected.kind)}</p>
              <h2 className="mt-1 break-words font-display text-2xl font-semibold text-strong">
                {selected.label}
              </h2>
              <p className="mt-1 text-sm text-muted">
                {connections.length} {connections.length === 1 ? 'connection' : 'connections'} in
                this view · {new Set(selectedEdges.map((edge) => edge.sourceMemoryId)).size} sources
              </p>
              <a
                className={`${btnSm.outline} mt-3 min-h-11 max-w-full whitespace-normal text-left`}
                href={`/profile/knowledge?view=map&entity=${encodeURIComponent(selected.id)}#knowledge-item`}
              >
                Review or edit {selected.label}
              </a>
              <div className="mt-5">
                <h3 className="text-sm font-semibold text-strong">Connections and evidence</h3>
                <div className="mt-2 divide-y divide-edge">
                  {connections.map(({ id, edge, sources, confirmed }) => {
                    const otherId = edge.subjectId === selected.id ? edge.objectId : edge.subjectId;
                    const other = nodeById.get(otherId);
                    return (
                      <article key={id} className="py-4">
                        <p
                          className={`mb-2 text-xs font-medium ${confirmed ? 'text-accent' : 'text-amber-700 dark:text-amber-300'}`}
                        >
                          {confirmed ? 'Confirmed connection' : 'Needs your review'}
                        </p>
                        <p className="text-sm font-semibold text-strong">
                          {edge.presentation.sentence}
                        </p>
                        {edge.validFrom || edge.validUntil ? (
                          <p className="mt-1 text-xs text-muted">
                            {edge.validFrom ?? 'Unknown start'} to{' '}
                            {edge.validUntil ?? 'no end recorded'}
                          </p>
                        ) : null}
                        {other && other.id !== selected.id ? (
                          <button
                            type="button"
                            className={`mt-1 min-h-11 text-sm text-accent underline-offset-4 hover:underline ${focusRing}`}
                            onClick={() => moveIn(other.id)}
                          >
                            Explore {other.label}
                          </button>
                        ) : null}
                        <details className="mt-1 text-sm">
                          <summary
                            className={`disclosure flex cursor-pointer items-center gap-2 rounded py-3 text-muted ${focusRing}`}
                          >
                            Supporting evidence ({sources.length})
                          </summary>
                          {sources.map((source) => (
                            <div
                              key={source.sourceMemoryId}
                              className="mb-3 border-l-2 border-edge pl-3"
                            >
                              <p className="mb-1 text-xs text-muted">
                                {source.reviewStatus === 'confirmed'
                                  ? 'Reviewed source connection'
                                  : 'Source connection not yet reviewed'}
                              </p>
                              <blockquote className="whitespace-pre-wrap break-words text-xs leading-5 text-muted">
                                {source.evidenceQuote ?? source.sourceContent}
                              </blockquote>
                              {source.evidenceQuote &&
                              source.evidenceQuote !== source.sourceContent ? (
                                <details className="mt-2 text-xs text-muted">
                                  <summary
                                    className={`disclosure flex cursor-pointer items-center gap-2 rounded py-2 ${focusRing}`}
                                  >
                                    Full source note
                                  </summary>
                                  <p className="whitespace-pre-wrap break-words leading-5">
                                    {source.sourceContent}
                                  </p>
                                </details>
                              ) : null}
                              <div className="mt-2">
                                <RemoveConnection
                                  relationId={source.id}
                                  sentence={edge.presentation.sentence}
                                />
                                <SourceImpactForget memoryId={source.sourceMemoryId} />
                              </div>
                            </div>
                          ))}
                        </details>
                      </article>
                    );
                  })}
                </div>
              </div>
            </>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
