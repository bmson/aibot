'use client';

import type { KnowledgeMapSnapshot, KnowledgeSourceImpact } from '@assistant/application';
import { Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { forgetKnowledgeMemory, loadKnowledgeSourceImpact } from '@/app/profile/knowledge/actions';
import {
  GLOBAL_MAP_HEIGHT,
  GLOBAL_MAP_WIDTH,
  layoutKnowledgeMap,
} from '@/app/profile/knowledge/global-map-model';
import { entityKindLabel, entityKindPaint, humanizePredicate } from '@/lib/knowledge';
import { btnSm, focusRing } from '@/lib/ui';

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

const INITIAL_VIEWPORT: Viewport = { x: 0, y: 0, scale: 1 };

export function GlobalKnowledgeMap({ snapshot }: { snapshot: KnowledgeMapSnapshot }) {
  const nodes = useMemo(() => layoutKnowledgeMap(snapshot), [snapshot]);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const [selectedId, setSelectedId] = useState(nodes[0]?.id ?? null);
  const [viewport, setViewport] = useState(INITIAL_VIEWPORT);
  const [impact, setImpact] = useState<KnowledgeSourceImpact | null>(null);
  const [pending, setPending] = useState(false);
  const drag = useRef<{ x: number; y: number; viewport: Viewport } | null>(null);
  const selected = selectedId ? nodeById.get(selectedId) : undefined;
  const selectedEdges = selected
    ? snapshot.edges.filter(
        (edge) => edge.subjectId === selected.id || edge.objectId === selected.id,
      )
    : [];
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
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
      <div
        className="relative min-w-0 overflow-hidden rounded-2xl border border-edge bg-[radial-gradient(circle_at_45%_45%,color-mix(in_oklab,var(--accent)_10%,transparent),transparent_52%)]"
        role="application"
        aria-label="Knowledge overview map. Drag to pan, use plus and minus to zoom, and select a node to inspect its evidence."
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the application role owns keyboard pan and zoom as the drag alternative.
        tabIndex={0}
        onKeyDown={(event) => {
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
            drag.current = { x: event.clientX, y: event.clientY, viewport };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            setViewport({
              ...drag.current.viewport,
              x: drag.current.viewport.x + event.clientX - drag.current.x,
              y: drag.current.viewport.y + event.clientY - drag.current.y,
            });
          }}
          onPointerUp={(event) => {
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
        >
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
            {snapshot.edges.map((edge) => {
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
                  strokeWidth={active ? 2.6 : 1.2}
                  className={active ? 'stroke-accent' : 'stroke-edge'}
                  opacity={selectedId && !active ? 0.28 : 0.72}
                />
              );
            })}
            {nodes.map((node) => {
              const selectedNode = node.id === selectedId;
              const radius = Math.min(15, 7 + Math.sqrt(node.degree) * 2);
              return (
                // biome-ignore lint/a11y/useSemanticElements: SVG cannot contain an HTML button; the group implements button keyboard semantics.
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.label}, ${entityKindLabel(node.kind)}, ${node.degree} connections`}
                  className={`cursor-pointer ${focusRing}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedId(node.id);
                    setImpact(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') setSelectedId(node.id);
                  }}
                >
                  <circle cx={node.x} cy={node.y} r={22} fill="transparent" />
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={radius}
                    className={entityKindPaint(node.kind).node}
                    strokeWidth={selectedNode ? 4 : 2}
                  />
                  {(nodes.length <= 42 || selectedNode) && (
                    <text
                      x={node.x}
                      y={node.y + radius + 14}
                      textAnchor="middle"
                      className="fill-strong text-[11px] font-medium"
                    >
                      {node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label}
                    </text>
                  )}
                </g>
              );
            })}
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

      <aside className="min-w-0 rounded-2xl border border-edge bg-raised p-5">
        {selected ? (
          <>
            <p className="font-mono text-xs tracking-[0.08em] text-muted uppercase">
              {entityKindLabel(selected.kind)}
            </p>
            <h2 className="mt-1 break-words font-display text-2xl font-semibold text-strong">
              {selected.label}
            </h2>
            <p className="mt-1 text-sm text-muted">{selected.degree} source-backed connections</p>
            <div className="mt-5 border-l-2 border-accent/50 pl-4">
              <p className="text-xs font-semibold tracking-[0.08em] text-accent uppercase">
                Evidence rail
              </p>
              <div className="mt-3 grid gap-4">
                {selectedEdges.map((edge) => {
                  const otherId = edge.subjectId === selected.id ? edge.objectId : edge.subjectId;
                  const other = nodeById.get(otherId);
                  return (
                    <article key={edge.id} className="relative">
                      <span className="absolute top-1.5 -left-[1.32rem] size-2.5 rounded-full bg-accent ring-4 ring-raised" />
                      <p className="text-sm font-semibold text-strong">
                        {humanizePredicate(edge.predicate)} {other?.label}
                      </p>
                      <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted">
                        {edge.sourceContent}
                      </p>
                      <button
                        type="button"
                        className="mt-2 text-xs font-medium text-danger hover:underline"
                        onClick={async () => {
                          setImpact(await loadKnowledgeSourceImpact(edge.sourceMemoryId));
                        }}
                      >
                        Forget source…
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>
            {impact ? (
              <div className="mt-5 rounded-xl border border-danger/30 bg-danger/5 p-4">
                <p className="text-sm font-semibold text-strong">Forget this source knowledge?</p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  Removes {impact.activeConnectionCount} active connection
                  {impact.activeConnectionCount === 1 ? '' : 's'} and {impact.orphanedItems.length}{' '}
                  item
                  {impact.orphanedItems.length === 1 ? '' : 's'} that would no longer be connected.
                  {impact.retiredProjectionCount > 0
                    ? ` It also clears ${impact.retiredProjectionCount} retired derived projection${impact.retiredProjectionCount === 1 ? '' : 's'}.`
                    : ''}{' '}
                  The source text is tombstoned so it is not learned again verbatim.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    className={btnSm.danger}
                    onClick={async () => {
                      setPending(true);
                      await forgetKnowledgeMemory(impact.memoryId);
                      setImpact(null);
                      setPending(false);
                    }}
                  >
                    <Trash2 className="size-3.5" /> {pending ? 'Forgetting…' : 'Forget knowledge'}
                  </button>
                  <button type="button" className={btnSm.outline} onClick={() => setImpact(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </aside>
    </div>
  );
}
