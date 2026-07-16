import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { eq, sql } from 'drizzle-orm';
import { createDb } from './client.js';
import {
  agents,
  approvalPolicies,
  budgets,
  contacts,
  modelRoles,
  models,
  rateLimits,
  schedules,
  voiceProfile,
} from './schema.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = path.join(repoRoot, '.env');
if (existsSync(envFile)) dotenv.config({ path: envFile });

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'bmson@bmson.com';
const OWNER_PHONE = process.env.OWNER_PHONE ?? '';

const db = createDb(DATABASE_URL);

// ── Agent identity ───────────────────────────────────────────────────────────

const [agent] = await db
  .insert(agents)
  .values({
    name: 'B Bot',
    email: 'bot@bmson.com',
    workspacePrefix: 'workspace/b-bot',
    timezone: 'America/Los_Angeles',
    locale: 'en',
    signature: "— B Bot (Baldvin's assistant)",
  })
  .onConflictDoUpdate({
    target: agents.email,
    set: { updatedAt: sql`now()` },
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

const roleSeed = [
  { role: 'plan', primaryModel: 'deepseek/deepseek-chat', fallbackModel: 'openai/gpt-oss-120b' },
  {
    role: 'classify',
    primaryModel: 'qwen/qwen3-30b-a3b-instruct-2507',
    fallbackModel: 'openai/gpt-oss-120b',
  },
  {
    role: 'extract',
    primaryModel: 'qwen/qwen3-30b-a3b-instruct-2507',
    fallbackModel: 'deepseek/deepseek-chat',
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

const budgetSeed = [
  { scope: 'task_default', limitUsd: '0.25' },
  { scope: 'daily', limitUsd: '2.00' },
  { scope: 'monthly', limitUsd: '20.00' },
] as const;

for (const b of budgetSeed) {
  await db.insert(budgets).values(b).onConflictDoNothing();
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

const existingOwner = await db.select().from(contacts).where(eq(contacts.trust, 'owner'));
if (existingOwner.length === 0) {
  await db.insert(contacts).values({
    name: 'Baldvin',
    emails: [OWNER_EMAIL],
    phones: OWNER_PHONE ? [OWNER_PHONE] : [],
    relationship: 'owner',
    trust: 'owner',
  });
}

// ── Voice profile singleton ──────────────────────────────────────────────────

await db.insert(voiceProfile).values({ id: 1 }).onConflictDoNothing();

// ── Default approval policies (v2's dynamic rules as data) ───────────────────

const policySeed = [
  {
    toolName: 'sms.send',
    templateKey: 'sms.reply_to_owner',
    match: {},
    effect: 'allow',
  },
  {
    toolName: 'calendar.create_event',
    templateKey: 'calendar.self_only_events',
    match: {},
    effect: 'allow',
  },
] as const;

for (const p of policySeed) {
  const existing = await db
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.templateKey, p.templateKey));
  if (existing.length === 0) {
    await db.insert(approvalPolicies).values({ ...p, agentId: agent.id, createdVia: 'seed' });
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
        "Prepare the owner's morning brief. Check: (1) today's events on your calendar and the owner's free/busy, (2) recent email in your inbox needing attention (gmail.search newer_than:1d), (3) goals list — anything slipping, (4) your own progress notes. Then send ONE concise brief via owner.notify: schedule, needs-attention items, and what you plan to do today. No fluff.",
    },
  },
  {
    name: 'memory-consolidation',
    cron: '0 9 * * 0',
    taskTemplate: {
      type: 'scheduled',
      budgetUsdLimit: '0.10',
      instruction:
        'Weekly memory maintenance: recall memories on the main recurring topics, identify duplicates or outdated experiences, and save consolidated, corrected knowledge memories where useful. Summarize what you changed via owner.notify in 2-3 lines.',
    },
  },
  {
    name: 'memory-extraction',
    cron: '0 22 * * *',
    taskTemplate: {
      type: 'scheduled',
      budgetUsdLimit: '0.10',
      instruction:
        "Nightly memory extraction: use conversations.search and memory.recall to review today's conversations and completed work. Save any lasting facts, preferences, or people as 'knowledge' memories and notable outcomes as 'experience' memories (memory.save) — but recall first and skip anything already stored. If nothing new was learned today, finish silently without saving or notifying.",
    },
  },
] as const;

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
  }
}

console.log(`seeded: agent ${agent.name} <${agent.email}> (${agent.id})`);
console.log(
  `seeded: ${modelSeed.length} models, ${roleSeed.length} roles, ${budgetSeed.length} budgets, ${rateLimitSeed.length} rate limits, ${policySeed.length} policies`,
);
process.exit(0);
