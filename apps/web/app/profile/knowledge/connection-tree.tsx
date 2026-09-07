'use client';

import { presentKnowledgeGraphRelation } from '@assistant/application/relationship-presentation';
import { ChevronRight, CornerDownRight, ExternalLink, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { entityKindLabel, entityKindPaint } from '@/lib/knowledge';
import { btnSm, focusRing } from '@/lib/ui';
import { loadConnectionSource, loadKnowledgeNeighborhood } from './actions';
import type { ExplorerEdge } from './explorer-model';
import { RemoveConnection } from './remove-connection';

type Node = ExplorerEdge['other'];

/** Group only identical directed, time-qualified claims; keep each source addressable. */
export function treeConnections(edges: ExplorerEdge[]): ExplorerEdge[][] {
  const groups = new Map<string, ExplorerEdge[]>();
  for (const edge of edges) {
    const key = JSON.stringify([
      edge.other.id,
      edge.predicate,
      edge.outbound,
      edge.validFrom,
      edge.validUntil,
    ]);
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    (a[0]?.other.label ?? '').localeCompare(b[0]?.other.label ?? ''),
  );
}

function Branch({
  group,
  parent,
  ancestors,
  focus,
  changed,
  revision,
}: {
  group: ExplorerEdge[];
  parent: Node;
  ancestors: string[];
  focus: (node: Node) => void;
  changed: () => void;
  revision: number;
}) {
  const [open, setOpen] = useState(false);
  const edge = group[0];
  if (!edge) return null;
  const node = edge.other;
  const cycle = ancestors.includes(node.id);
  const sentence = presentKnowledgeGraphRelation({
    subjectLabel: edge.outbound ? parent.label : node.label,
    objectLabel: edge.outbound ? node.label : parent.label,
    predicate: edge.predicate,
  }).sentence;
  return (
    <li className="min-w-0">
      <div className="group flex min-w-0 items-start gap-1 rounded-lg py-1 hover:bg-sunken/40">
        <button
          type="button"
          onClick={() => (cycle ? focus(node) : setOpen(!open))}
          aria-expanded={cycle ? undefined : open}
          aria-label={`${cycle ? 'Return to' : open ? 'Collapse' : 'Expand'} ${node.label}`}
          className={`flex size-11 shrink-0 items-center justify-center rounded-lg text-muted ${focusRing}`}
        >
          {cycle ? (
            <CornerDownRight className="size-4" />
          ) : (
            <ChevronRight
              className={`size-4 motion-safe:transition-transform ${open ? 'rotate-90' : ''}`}
            />
          )}
        </button>
        <div className="min-w-0 flex-1 py-2">
          <button
            type="button"
            onClick={() => focus(node)}
            className={`flex max-w-full items-center gap-2 rounded text-left font-medium text-strong ${focusRing}`}
          >
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${entityKindPaint(node.kind).swatch}`}
            />
            <span className="break-words">{node.label}</span>
          </button>
          <p className="mt-1 text-xs leading-5 text-muted">{sentence}</p>
          {edge.validFrom || edge.validUntil ? (
            <p className="text-xs text-muted">
              {edge.validFrom ?? 'Unknown start'} to {edge.validUntil ?? 'present'}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted">
            <span>{entityKindLabel(node.kind)}</span>
            {cycle ? <span>Already on this branch</span> : null}
            {group.some((item) => item.reviewStatus === 'unreviewed') ? (
              <span>Needs review</span>
            ) : null}
            <details className="min-w-0 basis-full">
              <summary className={`cursor-pointer rounded py-2 ${focusRing}`}>
                Manage connection · {group.length} {group.length === 1 ? 'source' : 'sources'}
              </summary>
              <div className="space-y-2 border-l border-edge pl-3">
                {group.map((item, index) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-1"
                  >
                    <ConnectionSource relationId={item.id} index={index + 1} />
                    <RemoveConnection
                      relationId={item.id}
                      sentence={sentence}
                      onRemoved={changed}
                    />
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>
      </div>
      {open && !cycle ? (
        <div className="ml-5 border-l border-edge pl-2 sm:pl-4">
          <TreeLevel
            node={node}
            ancestors={[...ancestors, node.id]}
            focus={focus}
            changed={changed}
            revision={revision}
          />
        </div>
      ) : null}
    </li>
  );
}

function TreeLevel({
  node,
  ancestors,
  focus,
  changed,
  revision,
}: {
  node: Node;
  ancestors: string[];
  focus: (node: Node) => void;
  changed: () => void;
  revision: number;
}) {
  const [result, setResult] = useState<{ edges: ExplorerEdge[]; total: number } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [limit, setLimit] = useState(50);
  // A collapsed branch unmounts. Its late response cannot replace a newer focus.
  useEffect(() => {
    let active = true;
    setError(false);
    void revision;
    void attempt;
    loadKnowledgeNeighborhood(node.id, limit)
      .then((value) => {
        if (active) setResult(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [node.id, limit, revision, attempt]);
  if (error)
    return (
      <div role="alert" className="py-3 text-sm text-muted">
        Couldn’t load connections.{' '}
        <button type="button" className={btnSm.outline} onClick={() => setAttempt(attempt + 1)}>
          Try again
        </button>
      </div>
    );
  if (!result)
    return (
      <p role="status" className="py-3 text-sm text-muted">
        Loading connections…
      </p>
    );
  const groups = treeConnections(result.edges);
  return (
    <>
      {groups.length ? (
        <ul className="min-w-0 divide-y divide-edge/40">
          {groups.map((group) => (
            <Branch
              key={group[0]?.id}
              group={group}
              parent={node}
              ancestors={ancestors}
              focus={focus}
              changed={changed}
              revision={revision}
            />
          ))}
        </ul>
      ) : (
        <p className="py-4 text-sm text-muted">No active connections recorded for {node.label}.</p>
      )}
      {result.total > result.edges.length ? (
        <div className="py-3 text-xs text-muted">
          Showing {result.edges.length} of {result.total} source records.{' '}
          {limit < 250 ? (
            <button
              type="button"
              className={btnSm.outline}
              onClick={() => setLimit(Math.min(250, limit + 50))}
            >
              Show more
            </button>
          ) : (
            'Focus another item to continue exploring.'
          )}
        </div>
      ) : null}
    </>
  );
}

export function ConnectionTree({ root }: { root: Node }) {
  const [trail, setTrail] = useState<Node[]>([root]);
  const [revision, setRevision] = useState(0);
  const current = trail[trail.length - 1] ?? root;
  const focus = (node: Node) =>
    setTrail((previous) => {
      const index = previous.findIndex((item) => item.id === node.id);
      return index < 0 ? [...previous, node] : previous.slice(0, index + 1);
    });
  return (
    <div className="min-w-0 rounded-xl border border-edge bg-raised">
      <div className="border-b border-edge p-4">
        <nav aria-label="Connection trail" className="flex flex-wrap items-center gap-1 text-sm">
          {trail.map((node, index) => (
            <span key={node.id} className="inline-flex min-w-0 items-center gap-1">
              {index ? <ChevronRight aria-hidden="true" className="size-3 text-muted" /> : null}
              <button
                type="button"
                aria-current={index === trail.length - 1 ? 'location' : undefined}
                onClick={() => setTrail(trail.slice(0, index + 1))}
                className={`min-h-11 rounded px-2 text-left ${index === trail.length - 1 ? 'font-semibold text-strong' : 'text-muted'} ${focusRing}`}
              >
                {node.label}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-prose text-xs leading-5 text-muted">
            Expand a branch to follow its connections. Select a name to focus. Each line describes a
            recorded relationship.
          </p>
          <button
            type="button"
            className={btnSm.outline}
            onClick={() => {
              setTrail([root]);
              setRevision(revision + 1);
            }}
          >
            <RotateCcw className="size-3" /> Reset
          </button>
        </div>
      </div>
      <div className="max-h-[640px] overflow-auto p-2 sm:p-4">
        <TreeLevel
          key={current.id}
          node={current}
          ancestors={[current.id]}
          focus={focus}
          changed={() => setRevision((value) => value + 1)}
          revision={revision}
        />
      </div>
      <Link
        className="flex min-h-11 items-center gap-2 border-t border-edge px-4 text-xs text-accent"
        href={`/profile/knowledge?view=map&entity=${current.id}#knowledge-item`}
      >
        <ExternalLink className="size-3" /> Edit {current.label} and add connections
      </Link>
    </div>
  );
}

function ConnectionSource({ relationId, index }: { relationId: string; index: number }) {
  const [source, setSource] = useState<{ content: string; sentence: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        className="min-h-11 text-accent underline"
        disabled={pending}
        onClick={async () => {
          if (source) {
            setSource(null);
            return;
          }
          setPending(true);
          setError(false);
          try {
            const result = await loadConnectionSource(relationId);
            setSource(result);
            setError(!result);
          } catch {
            setError(true);
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Loading…' : source ? 'Hide source' : `View source ${index}`}
      </button>
      {source ? (
        <blockquote className="whitespace-pre-wrap break-words py-2 text-sm leading-6 text-strong">
          {source.content}
        </blockquote>
      ) : null}
      {error ? <p role="alert">Couldn’t load this source. Try again.</p> : null}
    </div>
  );
}
