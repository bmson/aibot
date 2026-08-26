import {
  clipNodeLabel,
  entityKindLabel,
  entityKindPaint,
  humanizePredicate,
} from '@/lib/knowledge';

/**
 * A bounded node-link view of one entity's immediate neighbourhood, drawn as
 * server-rendered SVG. It stays a *local* map on purpose — an unbounded global
 * canvas is not what makes a personal graph reviewable — but unlike the grid of
 * cards it replaced, it shows direction, review state, and entity kind, and each
 * neighbour is a link, so the map is how you move around the graph.
 *
 * No client JS and no charting dependency: the layout is trigonometry over a
 * fixed ellipse, and every colour is a Tailwind utility, so the `@theme inline`
 * tokens flip it for dark mode without a second code path.
 */

export interface LocalMapEdge {
  id: string;
  predicate: string;
  /** True when the selected entity is the subject of the relation. */
  outbound: boolean;
  reviewStatus: 'unreviewed' | 'confirmed' | 'rejected';
  other: { id: string; label: string; kind: string };
}

/** Geometry. Width leaves room for the labels that hang off the outer nodes. */
const VIEW_W = 760;
const VIEW_H = 420;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
const RX = 230;
const RY = 150;
const CENTER_R = 13;
const NODE_R = 7;
/** Two-line neighbour labels stop being readable much past a dozen spokes. */
const MAX_NODES = 12;

function arrowhead(tipX: number, tipY: number, dx: number, dy: number): string {
  const length = 9;
  const half = 3.6;
  const baseX = tipX - dx * length;
  const baseY = tipY - dy * length;
  // Perpendicular to the direction, so the head stays square to its own edge.
  const px = -dy * half;
  const py = dx * half;
  return [
    `${tipX.toFixed(2)},${tipY.toFixed(2)}`,
    `${(baseX + px).toFixed(2)},${(baseY + py).toFixed(2)}`,
    `${(baseX - px).toFixed(2)},${(baseY - py).toFixed(2)}`,
  ].join(' ');
}

export function LocalMap({
  selected,
  edges,
  totalEdges,
  hrefForEntity,
}: {
  selected: { label: string; kind: string };
  edges: LocalMapEdge[];
  totalEdges: number;
  hrefForEntity: (entityId: string) => string;
}) {
  const shown = edges.slice(0, MAX_NODES);
  const kindsPresent = [...new Set([selected.kind, ...shown.map((edge) => edge.other.kind)])];

  const nodes = shown.map((edge, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / shown.length;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = CX + RX * cos;
    const y = CY + RY * sin;
    // Unit vector along the drawn line, which is not the ellipse angle once rx
    // and ry differ — using the raw angle skewed every arrowhead.
    const dx = x - CX;
    const dy = y - CY;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    return {
      edge,
      x,
      y,
      ux,
      uy,
      // Trim both ends so the line meets neither disc, leaving room for the head.
      x1: CX + ux * (CENTER_R + 3),
      y1: CY + uy * (CENTER_R + 3),
      x2: x - ux * (NODE_R + 3),
      y2: y - uy * (NODE_R + 3),
      anchorEnd: cos < 0,
    };
  });

  const description = shown
    .map(
      (edge) =>
        `${selected.label} ${edge.outbound ? '' : 'is the object of '}${humanizePredicate(
          edge.predicate,
        )} ${edge.outbound ? 'to ' : 'from '}${edge.other.label}`,
    )
    .join('; ');

  return (
    <div>
      <div className="overflow-hidden rounded-xl border border-edge bg-[radial-gradient(circle_at_center,rgba(81,143,106,0.12),transparent_48%)] p-2 sm:p-4">
        {shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">No active connections to draw yet.</p>
        ) : (
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            className="h-auto w-full"
            role="img"
            aria-labelledby="local-map-title local-map-desc"
          >
            <title id="local-map-title">{`Connections around ${selected.label}`}</title>
            <desc id="local-map-desc">{description}</desc>

            {nodes.map(({ edge, x1, y1, x2, y2, ux, uy }) => {
              const confirmed = edge.reviewStatus === 'confirmed';
              const lineClass = confirmed
                ? 'stroke-accent/70'
                : 'stroke-amber-500/80 dark:stroke-amber-400/80';
              const headClass = confirmed
                ? 'fill-accent/70'
                : 'fill-amber-500/80 dark:fill-amber-400/80';
              // The head sits at whichever end the relation points to, so an
              // incoming edge reads as incoming without hovering anything.
              const head = edge.outbound ? arrowhead(x2, y2, ux, uy) : arrowhead(x1, y1, -ux, -uy);
              return (
                <g key={edge.id}>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    strokeWidth={1.5}
                    strokeDasharray={confirmed ? undefined : '4 3'}
                    className={lineClass}
                  />
                  <polygon points={head} className={headClass} />
                </g>
              );
            })}

            {nodes.map(({ edge, x, y, anchorEnd }) => {
              const paint = entityKindPaint(edge.other.kind);
              const labelX = anchorEnd ? x - (NODE_R + 5) : x + NODE_R + 5;
              return (
                <a key={edge.id} href={hrefForEntity(edge.other.id)}>
                  <title>
                    {`${edge.other.label} — ${entityKindLabel(edge.other.kind)} · ${
                      edge.outbound ? 'outgoing' : 'incoming'
                    } ${humanizePredicate(edge.predicate)}`}
                  </title>
                  <circle cx={x} cy={y} r={NODE_R} strokeWidth={2} className={paint.node} />
                  <text
                    x={labelX}
                    y={y + 1}
                    textAnchor={anchorEnd ? 'end' : 'start'}
                    className="fill-strong text-[12px] font-medium"
                  >
                    {clipNodeLabel(edge.other.label)}
                  </text>
                  <text
                    x={labelX}
                    y={y + 13}
                    textAnchor={anchorEnd ? 'end' : 'start'}
                    className="fill-muted text-[9.5px]"
                  >
                    {`${edge.outbound ? '→' : '←'} ${clipNodeLabel(humanizePredicate(edge.predicate), 22)}`}
                  </text>
                </a>
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
          </svg>
        )}
      </div>

      {shown.length > 0 ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {kindsPresent.map((kind) => (
              <span key={kind} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={`inline-block size-2 rounded-full ${entityKindPaint(kind).swatch}`}
                />
                {entityKindLabel(kind)}
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
          {/* The diagram's content as text: the <desc> above is a summary, this
              is the navigable equivalent for anyone not reading the drawing. */}
          <ul className="sr-only">
            {shown.map((edge) => (
              <li key={edge.id}>
                <a href={hrefForEntity(edge.other.id)}>
                  {`${edge.other.label} (${entityKindLabel(edge.other.kind)}) — ${
                    edge.outbound ? 'outgoing' : 'incoming'
                  } ${humanizePredicate(edge.predicate)}${
                    edge.reviewStatus === 'confirmed' ? '' : ', needs review'
                  }`}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {totalEdges > shown.length ? (
        <p className="mt-2 text-xs text-muted">
          Showing {shown.length} of {totalEdges.toLocaleString()} active connections. All of them
          are listed below with their evidence.
        </p>
      ) : null}
    </div>
  );
}
