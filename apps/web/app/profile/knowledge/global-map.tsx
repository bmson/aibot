'use client';

import type { KnowledgeMapSnapshot } from '@assistant/application';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  GLOBAL_MAP_HEIGHT,
  GLOBAL_MAP_WIDTH,
  knowledgeConnections,
  layoutKnowledgeMap,
  mapPanDelta,
} from '@/app/profile/knowledge/global-map-model';
import { SourceImpactForget } from '@/app/profile/knowledge/source-impact-forget';
import { entityKindLabel, entityKindPaint } from '@/lib/knowledge';
import { btnSm, focusRing, inputClass } from '@/lib/ui';
import { ConnectionTree } from './connection-tree';
import { RemoveConnection } from './remove-connection';

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

export function GlobalKnowledgeMap({
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
  const [view, setView] = useState<'map' | 'tree'>('map');
  const [nearbyOnly, setNearbyOnly] = useState(false);
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT);
  const drag = useRef<{
    x: number;
    y: number;
    width: number;
    moved: boolean;
    viewport: Viewport;
  } | null>(null);
  const suppressClick = useRef(false);
  // Filters arrive as search params, so this component re-renders in place
  // with a new snapshot rather than remounting. Falling back keeps the
  // inspector populated; reading state alone left the whole panel blank
  // whenever the previous selection filtered out.
  const selected = (selectedId ? nodeById.get(selectedId) : undefined) ?? nodes[0];
  const selectedEdges = useMemo(
    () =>
      selected
        ? snapshot.edges.filter(
            (edge) => edge.subjectId === selected.id || edge.objectId === selected.id,
          )
        : [],
    [snapshot.edges, selected],
  );
  const activeId = selected?.id ?? null;
  const connections = useMemo(
    () => (selected ? knowledgeConnections(snapshot, selected.id) : []),
    [snapshot, selected],
  );
  const neighbors = useMemo(
    () => new Set(selectedEdges.flatMap((edge) => [edge.subjectId, edge.objectId])),
    [selectedEdges],
  );
  const browseNodes = nodes.filter((node) =>
    node.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  // Panning fires setViewport on every pointer move, and only the wrapping
  // <g> transform changes with it. Memoising the marks keeps a drag from
  // re-reconciling every node and edge on the map, sixty times a second.
  const edgeMarks = useMemo(
    () =>
      snapshot.edges.map((edge) => {
        const subject = nodeById.get(edge.subjectId);
        const object = nodeById.get(edge.objectId);
        if (!subject || !object) return null;
        const active = activeId === subject.id || activeId === object.id;
        if (nearbyOnly && !active) return null;
        return (
          <line
            key={edge.id}
            x1={subject.x}
            y1={subject.y}
            x2={object.x}
            y2={object.y}
            strokeWidth={active ? 2.6 : 1.2}
            className={active ? 'stroke-accent' : 'stroke-edge'}
            opacity={activeId && !active ? 0.28 : 0.72}
            strokeDasharray={edge.reviewStatus === 'unreviewed' ? '5 4' : undefined}
          />
        );
      }),
    [snapshot.edges, nodeById, activeId, nearbyOnly],
  );
  const nodeMarks = useMemo(
    () =>
      nodes.map((node) => {
        const isSelected = node.id === activeId;
        if (nearbyOnly && !neighbors.has(node.id) && !isSelected) return null;
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
            onClick={(event) => {
              event.stopPropagation();
              if (suppressClick.current) return;
              setSelectedId(node.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                // Space scrolls the page otherwise, jumping the map out of view.
                event.preventDefault();
                setSelectedId(node.id);
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
            {(nodes.length <= 42 || isSelected || neighbors.has(node.id)) && (
              <text
                x={node.x}
                y={node.y + radius + 14}
                textAnchor="middle"
                className="fill-strong text-[16px] font-medium"
              >
                {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
              </text>
            )}
          </g>
        );
      }),
    [nodes, activeId, nearbyOnly, neighbors],
  );
  const zoom = (factor: number) =>
    setViewport((current) => ({
      ...current,
      scale: Math.max(0.5, Math.min(2.8, current.scale * factor)),
    }));

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

  return (
    <div className="min-w-0">
      <fieldset className="mb-4 flex flex-wrap items-center gap-2" aria-label="Connection view">
        <button
          type="button"
          aria-pressed={view === 'map'}
          className={btnSm.outline}
          onClick={() => setView('map')}
        >
          Map
        </button>
        <button
          type="button"
          aria-pressed={view === 'tree'}
          className={btnSm.outline}
          onClick={() => setView('tree')}
        >
          Tree
        </button>
        <span className="text-xs text-muted">
          {view === 'tree'
            ? 'Explore all connections around the selected item, one branch at a time.'
            : 'Select an item, then switch to Tree to follow its branches.'}
        </span>
      </fieldset>
      {view === 'tree' && selected ? <ConnectionTree key={selected.id} root={selected} /> : null}
      <div
        className={`${view === 'tree' ? 'hidden' : 'grid'} min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]`}
      >
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <label className="hidden min-h-11 items-center gap-2 text-sm text-muted md:flex">
              <input
                type="checkbox"
                checked={nearbyOnly}
                onChange={(event) => setNearbyOnly(event.target.checked)}
              />
              Only selected item and its connections
            </label>
            <p className="text-xs text-muted">Solid: confirmed · Dashed: needs review</p>
          </div>
          <div
            className="relative hidden min-w-0 overflow-hidden rounded-2xl border border-edge bg-sunken/20 md:block"
            role="application"
            aria-label="Knowledge overview map. Drag to pan, use plus and minus to zoom, and select a node to inspect its evidence."
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the application role owns keyboard pan and zoom as the drag alternative.
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (
                ['+', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                  event.key,
                )
              )
                event.preventDefault();
              if (event.key === '+') zoom(1.2);
              if (event.key === '-') zoom(1 / 1.2);
              if (event.key === '0') setViewport(INITIAL_VIEWPORT);
              const delta = 42;
              if (event.key === 'ArrowLeft') setViewport((v) => ({ ...v, x: v.x + delta }));
              if (event.key === 'ArrowRight') setViewport((v) => ({ ...v, x: v.x - delta }));
              if (event.key === 'ArrowUp') setViewport((v) => ({ ...v, y: v.y + delta }));
              if (event.key === 'ArrowDown') setViewport((v) => ({ ...v, y: v.y - delta }));
            }}
          >
            <svg
              viewBox={`0 0 ${GLOBAL_MAP_WIDTH} ${GLOBAL_MAP_HEIGHT}`}
              className="h-auto w-full touch-none select-none"
              role="img"
              aria-label={`${nodes.length} connected knowledge items across ${snapshot.components.length} groups`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                suppressClick.current = false;
                drag.current = {
                  x: event.clientX,
                  y: event.clientY,
                  width: event.currentTarget.getBoundingClientRect().width,
                  moved: false,
                  viewport,
                };
              }}
              onPointerMove={(event) => {
                if (!drag.current) return;
                const dx = event.clientX - drag.current.x;
                const dy = event.clientY - drag.current.y;
                if (!drag.current.moved && Math.hypot(dx, dy) < 5) return;
                drag.current.moved = true;
                suppressClick.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                const delta = mapPanDelta(dx, dy, drag.current.width);
                setViewport({
                  ...drag.current.viewport,
                  x: drag.current.viewport.x + delta.x,
                  y: drag.current.viewport.y + delta.y,
                });
              }}
              onPointerUp={(event) => {
                drag.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                drag.current = null;
                suppressClick.current = true;
              }}
              onLostPointerCapture={() => {
                drag.current = null;
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
                onClick={() => zoom(1.2)}
              >
                <Plus className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                className={btnSm.outline}
                onClick={() => zoom(1 / 1.2)}
              >
                <Minus className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Reset map"
                className={btnSm.outline}
                onClick={() => setViewport(INITIAL_VIEWPORT)}
              >
                <RotateCcw className="size-4" />
              </button>
            </div>
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
                onClick={() => setSelectedId(node.id)}
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
                            onClick={() => setSelectedId(other.id)}
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
