import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from './client.js';
import {
  agents,
  approvalPolicies,
  budgets,
  contacts,
  modelRoles,
  models,
  rateLimits,
  rateTable,
  schedules,
  voiceProfile,
} from './schema.js';
import { resolveOwnerPolicyValues } from './seed-values.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) dotenv.config({ path: envFile });

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'bmson@bmson.com';
const OWNER_PHONE = process.env.OWNER_PHONE ?? '';

const db = createDb(DATABASE_URL);

// ── Agent identity ───────────────────────────────────────────────────────────

// The display name is seed-owned, while timezone, locale, and signature are
// owner-editable settings and must survive the reconciliation run on deploy.
// The workspace prefix is storage identity — never renamed.
const AGENT_NAME = 'AI Bot';
const AGENT_SIGNATURE = "— AI Bot (Baldvin's assistant)";

const [agent] = await db
  .insert(agents)
  .values({
    name: AGENT_NAME,
    email: 'bot@bmson.com',
    workspacePrefix: 'workspace/b-bot',
    timezone: 'America/Los_Angeles',
    locale: 'en',
    signature: AGENT_SIGNATURE,
  })
  .onConflictDoUpdate({
    target: agents.email,
    set: { name: AGENT_NAME, updatedAt: sql`now()` },
  })
  .returning();

if (!agent) throw new Error('agent seed failed');

// ── Model capability matrix ──────────────────────────────────────────────────
// OpenRouter model ids. Cost columns are routing hints; usage.cost is authoritative.

const modelSeed = [
  {
    id: 'qwen/qwen3-30b-a3b-instruct-2507',
    label: 'Qwen3 30B A3B Instruct',
    capabilities: { tools: true, vision: false, json: true, streaming: true, thinking: false },
    promptCostPerMTok: '0.10',
    completionCostPerMTok: '0.30',
    latencyClass: 'fast',
  },
  {
    id: 'deepseek/deepseek-chat',
    label: 'DeepSeek Chat',
    capabilities: { tools: true, vision: false, json: true, streaming: true, thinking: false },
    promptCostPerMTok: '0.30',
    completionCostPerMTok: '1.00',
    latencyClass: 'medium',
  },
  {
    id: 'openai/gpt-oss-120b',
    label: 'GPT-OSS 120B',
    capabilities: { tools: true, vision: false, json: true, streaming: true, thinking: true },
    promptCostPerMTok: '0.15',
    completionCostPerMTok: '0.60',
    latencyClass: 'fast',
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    label: 'Claude Sonnet 4.5',
    capabilities: { tools: true, vision: true, json: true, streaming: true, thinking: true },
    promptCostPerMTok: '3.00',
    completionCostPerMTok: '15.00',
    latencyClass: 'medium',
  },
  {
    id: 'openai/text-embedding-3-small',
    label: 'OpenAI Text Embedding 3 Small',
    capabilities: { embedding: true },
    promptCostPerMTok: '0.02',
    completionCostPerMTok: '0',
    latencyClass: 'fast',
  },
] as const;

for (const m of modelSeed) {
  await db
    .insert(models)
    .values({ ...m, capabilities: { ...m.capabilities } })
    .onConflictDoNothing();
}

// ── Role routing ─────────────────────────────────────────────────────────────

// Structured-output roles run at temperature 0: plan/classify/extract must
// produce schema-valid JSON deterministically. A non-zero (provider-default)
// temperature is a plausible root cause of the AI_NoObjectGeneratedError parse
// failures. Migration 0023 applies the same params to existing rows still at {}.
const DETERMINISTIC = { temperature: 0 };

const roleSeed = [
  {
    role: 'plan',
    primaryModel: 'deepseek/deepseek-chat',
    fallbackModel: 'openai/gpt-oss-120b',
    params: DETERMINISTIC,
  },
  {
    role: 'classify',
    primaryModel: 'qwen/qwen3-30b-a3b-instruct-2507',
    fallbackModel: 'openai/gpt-oss-120b',
    params: DETERMINISTIC,
  },
  {
    // Structured extraction (memory extraction/consolidation/import). qwen3-30b
    // too often returns JSON that fails schema parsing, so the stronger
    // deepseek-chat is primary with a distinct capable fallback. Migration 0019
    // applies the same change to existing databases (seed is onConflictDoNothing).
    role: 'extract',
    primaryModel: 'deepseek/deepseek-chat',
    fallbackModel: 'openai/gpt-oss-120b',
    params: DETERMINISTIC,
  },
  { role: 'draft', primaryModel: 'deepseek/deepseek-chat', fallbackModel: 'openai/gpt-oss-120b' },
  {
    role: 'reason',
    primaryModel: 'anthropic/claude-sonnet-4.5',
    fallbackModel: 'deepseek/deepseek-chat',
  },
  {
    role: 'rewrite',
    primaryModel: 'deepseek/deepseek-chat',
    fallbackModel: 'qwen/qwen3-30b-a3b-instruct-2507',
  },
  {
    role: 'embed',
    primaryModel: 'openai/text-embedding-3-small',
    fallbackModel: 'openai/text-embedding-3-small',
  },
] as const;

for (const r of roleSeed) {
  await db.insert(modelRoles).values(r).onConflictDoNothing();
}

// ── Budgets & rate limits ────────────────────────────────────────────────────

// Raised for the reason-model routing (Phase 3): interactive owner actions now
// run on Claude (~$0.10-0.15/action), so the ceilings give real headroom while
// staying bounded. Migration 0023 lifts existing rows still at the old values,
// leaving any the owner has since edited untouched.
const budgetSeed = [
  { scope: 'task_default', limitUsd: '0.50' },
  { scope: 'daily', limitUsd: '4.00' },
  { scope: 'monthly', limitUsd: '50.00' },
] as const;

for (const b of budgetSeed) {
  await db.insert(budgets).values(b).onConflictDoNothing();
}

// ── Rate table (Phase 27) — unit prices for non-model spend ─────────────────
// Model costs come from OpenRouter usage.cost; everything else prices from here.

const rateSeed = [
  { key: 'embedding_mtok', unit: 'mtok', unitPriceUsd: '0.02' },
  { key: 'twilio_sms', unit: 'message', unitPriceUsd: '0.0079' },
  { key: 'twilio_voice_min', unit: 'minute', unitPriceUsd: '0.014' },
  // 2 vCPU + 2 GiB Cloud Run job: ~2×$0.000024/vCPU-s + 2×$0.0000025/GiB-s
  { key: 'cloud_run_job_sec', unit: 'second', unitPriceUsd: '0.00006' },
  { key: 'storage_gb_month', unit: 'gb-month', unitPriceUsd: '0.023' },
] as const;

for (const r of rateSeed) {
  await db.insert(rateTable).values(r).onConflictDoNothing();
}

const rateLimitSeed = [
  { scope: 'tool:gmail.send', maxPerHour: 10, maxPerDay: 50 },
  { scope: 'tool:sms.send', maxPerHour: 10, maxPerDay: 50 },
  { scope: 'channel:sms', maxPerHour: 30, maxPerDay: 200 },
  { scope: 'task', maxPerHour: 120, maxPerDay: 1000 },
] as const;

for (const r of rateLimitSeed) {
  await db.insert(rateLimits).values(r).onConflictDoNothing();
}

// ── Owner contact ────────────────────────────────────────────────────────────

let [ownerContact] = await db.select().from(contacts).where(eq(contacts.trust, 'owner')).limit(1);
if (!ownerContact) {
  [ownerContact] = await db
    .insert(contacts)
    .values({
      name: 'Baldvin',
      emails: [OWNER_EMAIL],
      phones: OWNER_PHONE ? [OWNER_PHONE] : [],
      relationship: 'owner',
      trust: 'owner',
    })
    .returning();
}
const ownerPolicyValues = resolveOwnerPolicyValues(ownerContact, {
  email: OWNER_EMAIL,
  phone: OWNER_PHONE,
});

// ── Voice profile singleton ──────────────────────────────────────────────────

// An honest baseline (not a fabricated idiosyncratic style): it activates the
// outbound voice rewrite as a consistency enforcer for plain, warm, filler-free
// writing. Real uploaded/sampled writing later refines this. Migration 0024
// backfills existing databases whose singleton is still empty; the owner's own
// edits (a non-empty description) are never overwritten.
const DEFAULT_VOICE = {
  description:
    'Plain, warm, and direct — writes like a capable human colleague. Short sentences, concrete, no corporate filler.',
  dos: [
    'Get to the point; lead with the useful thing',
    'Sound warm and human, not formal or robotic',
    'Keep sentences short and concrete',
  ],
  donts: [
    'No corporate filler or AI throat-clearing ("I hope this helps", "As an AI", "Certainly!")',
    'No hedging preambles before the answer',
    'Do not over-explain or pad',
  ],
};

await db
  .insert(voiceProfile)
  .values({ id: 1, ...DEFAULT_VOICE })
  .onConflictDoNothing();

// ── Default approval policies (v2's dynamic rules as data) ───────────────────

const policySeed = [
  {
    toolName: 'sms.send',
    templateKey: 'sms.reply_to_owner',
    match: { phone: ownerPolicyValues.phone },
    effect: 'allow',
  },
  {
    toolName: 'calendar.create_event',
    templateKey: 'calendar.self_only_events',
    match: {},
    effect: 'allow',
  },
  // Inviting the owner (and only the owner) to an event is autonomous — the
  // invite email goes nowhere but to them.
  {
    toolName: 'calendar.create_event',
    templateKey: 'calendar.owner_attendee_only',
    match: { emails: ownerPolicyValues.emails },
    effect: 'allow',
  },
] as const;

for (const p of policySeed) {
  const existing = await db
    .select()
    .from(approvalPolicies)
    .where(
      and(eq(approvalPolicies.agentId, agent.id), eq(approvalPolicies.templateKey, p.templateKey)),
    );
  if (existing.length === 0) {
    await db.insert(approvalPolicies).values({ ...p, agentId: agent.id, createdVia: 'seed' });
  } else if (existing[0]?.createdVia === 'seed') {
    // Seed-owned rules carry environment-derived owner addresses. Reconcile
    // those values on release without re-enabling a rule the owner paused.
    await db
      .update(approvalPolicies)
      .set({ toolName: p.toolName, match: p.match, effect: p.effect, updatedAt: sql`now()` })
      .where(eq(approvalPolicies.id, existing[0].id));
  }
}

// ── Default proactive schedules (next_run_at initialized by the first sweep) ─

const scheduleSeed = [
  {
    name: 'morning-brief',
    cron: '30 7 * * *',
    taskTemplate: {
      type: 'scheduled',
      budgetUsdLimit: '0.10',
      instruction:
        "Prepare the owner's morning brief. Check: (1) today's events on your calendar and the owner's free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) upcoming occasions in the next several days (occasions.list) — birthdays or anniversaries to prepare for, (5) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, any upcoming occasion, and what you plan to do today. No fluff.",
    },
  },
  // Phase 8: extraction and consolidation are code jobs, not model-prompted
  // tasks — the executor dispatches on taskTemplate.job. Extraction reviews
  // the day's conversations; consolidation dedupes/resolves per entity and
  // recompiles the owner card. Consolidation runs after extraction.
  {
    name: 'memory-extraction',
    cron: '0 22 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'memory.extract' },
  },
  {
    name: 'memory-consolidation',
    cron: '30 22 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'memory.consolidate' },
  },
  // Phase 2 (long-running chat): segment the day's conversations into topic
  // summaries recall can retrieve. A code job like extraction/consolidation;
  // runs before them so summaries reflect the freshest boundaries.
  {
    name: 'chat-segmentation',
    cron: '0 21 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.10', job: 'chat.segment' },
  },
  // Phase 18: nightly approval-anomaly scan over policy-matched auto-executions.
  // Runs after extraction/consolidation; a code job (no model), so budget is nominal.
  {
    name: 'anomaly-scan',
    cron: '0 23 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.05', job: 'anomaly.scan' },
  },
  // Phase 26: nightly reflection distills reusable skills from the day's
  // non-obvious task successes. Runs after consolidation; a model job.
  {
    name: 'skill-reflection',
    cron: '30 23 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.15', job: 'skill.reflect' },
  },
  // Phase 12: nightly self-improvement eval — mine failures/retries/cost outliers
  // into an experience memory + owner-approved change proposals (never applied).
  {
    name: 'self-improve',
    cron: '0 0 * * *',
    taskTemplate: { type: 'scheduled', budgetUsdLimit: '0.15', job: 'self.improve' },
  },
] as const;

/** Schedules whose definition the seed owns — updated in place on re-seed (prod picks up changes on deploy). */
const SEED_OWNED_SCHEDULES = new Set([
  'memory-extraction',
  'memory-consolidation',
  'chat-segmentation',
  'anomaly-scan',
  'skill-reflection',
  'self-improve',
]);

for (const s of scheduleSeed) {
  const existing = await db.select().from(schedules).where(eq(schedules.name, s.name));
  if (existing.length === 0) {
    await db.insert(schedules).values({
      agentId: agent.id,
      name: s.name,
      cron: s.cron,
      taskTemplate: { ...s.taskTemplate },
      enabled: true,
    });
  } else if (SEED_OWNED_SCHEDULES.has(s.name)) {
    await db
      .update(schedules)
      .set({
        cron: s.cron,
        taskTemplate: { ...s.taskTemplate },
        // next_run_at recomputes on the next sweep against the new cron
        nextRunAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(schedules.name, s.name));
  }
}

console.log(`seeded: agent ${agent.name} <${agent.email}> (${agent.id})`);
console.log(
  `seeded: ${modelSeed.length} models, ${roleSeed.length} roles, ${budgetSeed.length} budgets, ${rateLimitSeed.length} rate limits, ${policySeed.length} policies`,
);
process.exit(0);
