/**
 * Review what the models actually said.
 *
 * `LLM_AUDIT_CAPTURE` records every generative call at the one seam they all
 * pass through; this reads that table back and answers the questions the cost
 * ledger cannot: which surfaces are busiest, which are slowest, and which are
 * emitting output with defects in it.
 *
 * The grading is deterministic and needs no model call and no credential, so
 * this is safe to run against a production replica. It judges the text alone —
 * a clean report means no *detectable* defect, not that the answers were right.
 * Whether an answer was grounded in its evidence is a different question, and
 * the response contract already answers it for reads.
 *
 *   pnpm audit:llm                 # last 7 days, local DATABASE_URL
 *   pnpm audit:llm --days 30
 *   pnpm audit:llm --role draft    # one role
 *   pnpm audit:llm --prod          # PROD_DATABASE_URL, read-only transaction
 *   pnpm audit:llm --json out.json
 *   pnpm audit:llm --show unclosed-code-fence   # print offending records
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type AuditDefectKind, gradeAuditedOutput } from '@assistant/core';
import { createDb, modelCallAudit } from '@assistant/db';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

try {
  process.loadEnvFile('.env');
} catch {
  /* Environment may be supplied directly. */
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const days = Number(flag('days') ?? 7);
if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
const role = flag('role');
const jsonOut = flag('json');
const show = flag('show') as AuditDefectKind | undefined;

const url = has('prod') ? process.env.PROD_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    has('prod')
      ? 'PROD_DATABASE_URL is required with --prod.'
      : 'DATABASE_URL is required. Start the database, or pass --prod to read the deployed one.',
  );
}

interface SurfaceStats {
  calls: number;
  latencies: number[];
  outputTokens: number;
  defects: Map<AuditDefectKind, number>;
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);

const db = createDb(url, { max: 1 });
try {
  const rows = await db.transaction(async (tx) => {
    // Read-only: this tool never writes, and saying so keeps an accidental
    // --prod run from being able to.
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return tx
      .select({
        id: modelCallAudit.id,
        createdAt: modelCallAudit.createdAt,
        role: modelCallAudit.role,
        model: modelCallAudit.model,
        method: modelCallAudit.method,
        capture: modelCallAudit.capture,
        output: modelCallAudit.output,
        finishReason: modelCallAudit.finishReason,
        latencyMs: modelCallAudit.latencyMs,
        outputTokens: modelCallAudit.outputTokens,
        taskId: modelCallAudit.taskId,
      })
      .from(modelCallAudit)
      .where(
        and(
          gte(modelCallAudit.createdAt, sql`now() - make_interval(days => ${days})`),
          ...(role ? [eq(modelCallAudit.role, role)] : []),
        ),
      )
      .orderBy(desc(modelCallAudit.createdAt));
  });

  if (rows.length === 0) {
    console.log(`No captured model calls in the last ${days} day(s).`);
    console.log(
      'Capture is off by default. Set LLM_AUDIT_CAPTURE=redacted (or full) and let it collect.',
    );
    process.exit(0);
  }

  const surfaces = new Map<string, SurfaceStats>();
  const offenders: Array<{ kind: AuditDefectKind; detail: string; row: (typeof rows)[number] }> =
    [];
  let totalDefects = 0;

  for (const row of rows) {
    const key = `${row.role}/${row.method}`;
    const stats = surfaces.get(key) ?? {
      calls: 0,
      latencies: [],
      outputTokens: 0,
      defects: new Map<AuditDefectKind, number>(),
    };
    stats.calls += 1;
    if (row.latencyMs !== null) stats.latencies.push(row.latencyMs);
    stats.outputTokens += row.outputTokens;

    const defects = gradeAuditedOutput(row.output, {
      finishReason: row.finishReason,
      // `object` calls return JSON; the prose checks do not apply to them.
      structured: row.method === 'object',
    });
    for (const defect of defects) {
      stats.defects.set(defect.kind, (stats.defects.get(defect.kind) ?? 0) + 1);
      totalDefects += 1;
      if (show && defect.kind === show) offenders.push({ ...defect, row });
    }
    surfaces.set(key, stats);
  }

  const captures = new Set(rows.map((row) => row.capture));
  console.log(`\nCaptured model output — last ${days} day(s)${role ? `, role ${role}` : ''}`);
  console.log(
    `${rows.length} calls across ${surfaces.size} surfaces · capture: ${[...captures].join(', ')}`,
  );
  console.log(`${totalDefects} defect(s) found by deterministic checks\n`);

  const header = ['surface', 'calls', 'p50 ms', 'p95 ms', 'out tok', 'defects'];
  const table = [...surfaces.entries()]
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([key, stats]) => {
      const sorted = [...stats.latencies].sort((a, b) => a - b);
      const defectSummary =
        stats.defects.size === 0
          ? '—'
          : [...stats.defects.entries()].map(([kind, n]) => `${kind}×${n}`).join(', ');
      return [
        key,
        String(stats.calls),
        String(pct(sorted, 0.5)),
        String(pct(sorted, 0.95)),
        String(stats.outputTokens),
        defectSummary,
      ];
    });

  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...table.map((line) => (line[i] ?? '').length)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
  console.log(render(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const line of table) console.log(render(line));

  if (show) {
    console.log(`\nRecords with ${show} (${offenders.length}):\n`);
    for (const { detail, row } of offenders.slice(0, 20)) {
      const when = row.createdAt.toISOString();
      console.log(`  ${when}  ${row.role}/${row.method}  ${row.model}`);
      console.log(`    ${detail}`);
      if (row.taskId) console.log(`    task ${row.taskId}`);
    }
    if (offenders.length > 20) console.log(`  … and ${offenders.length - 20} more`);
  } else if (totalDefects > 0) {
    console.log('\nRe-run with --show <defect-kind> to see the records behind a column.');
  }

  if (jsonOut) {
    await mkdir(path.dirname(path.resolve(jsonOut)), { recursive: true });
    await writeFile(
      path.resolve(jsonOut),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          windowDays: days,
          calls: rows.length,
          totalDefects,
          surfaces: [...surfaces.entries()].map(([key, stats]) => {
            const sorted = [...stats.latencies].sort((a, b) => a - b);
            return {
              surface: key,
              calls: stats.calls,
              p50Ms: pct(sorted, 0.5),
              p95Ms: pct(sorted, 0.95),
              outputTokens: stats.outputTokens,
              defects: Object.fromEntries(stats.defects),
            };
          }),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.log(`\nWrote ${jsonOut}`);
  }
  console.log();
} finally {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
}
