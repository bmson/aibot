import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createPostgresApprovalPolicyRepository } from './approval-policy-repository.js';
import { createDb } from './client.js';
import { agents, approvalPolicies, approvals, tasks, toolCalls } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL;

function testDatabaseUrl(): string {
  if (!DATABASE_URL || !new URL(DATABASE_URL).pathname.endsWith('_test'))
    throw new Error('Requires isolated _test database');
  return DATABASE_URL;
}

async function fixture() {
  const db = createDb(testDatabaseUrl());
  const [owner] = await db.select().from(agents).limit(1);
  if (!owner) throw new Error('Seed the test database');
  const secondaryId = randomUUID();
  await db.insert(agents).values({
    id: secondaryId,
    name: `policy-test-${secondaryId.slice(0, 8)}`,
    email: `${secondaryId}@policy-test.invalid`,
    workspacePrefix: `policy-test/${secondaryId}`,
  });
  const policyIds: string[] = [];
  const taskIds: string[] = [];
  const toolCallIds: string[] = [];
  const approvalIds: string[] = [];
  return {
    db,
    ownerId: owner.id,
    secondaryId,
    repository: createPostgresApprovalPolicyRepository(db),
    async policy(agentId: string, options: { toolName: string; enabled?: boolean }) {
      const id = randomUUID();
      await db.insert(approvalPolicies).values({
        id,
        agentId,
        toolName: options.toolName,
        templateKey: `test.${id}`,
        match: { marker: id },
        effect: 'allow',
        version: 1,
        enabled: options.enabled ?? true,
        createdVia: 'settings',
      });
      policyIds.push(id);
      return id;
    },
    async historicalApproval(agentId: string, policyId: string) {
      const taskId = randomUUID();
      const toolCallId = randomUUID();
      const approvalId = randomUUID();
      await db.insert(tasks).values({
        id: taskId,
        agentId,
        type: 'adhoc',
        trust: 'assistant',
        status: 'pending',
      });
      await db.insert(toolCalls).values({
        id: toolCallId,
        taskId,
        step: 0,
        toolName: 'test.policy',
        risk: 'approval',
        status: 'approved',
      });
      await db.insert(approvals).values({
        id: approvalId,
        taskId,
        toolCallId,
        shortCode: `P${approvalId.slice(0, 8)}`,
        summary: 'policy history test',
        status: 'approved',
        expiresAt: new Date('2026-09-13T12:00:00.000Z'),
        createdPolicyId: policyId,
      });
      await db.update(toolCalls).set({ approvalId }).where(eq(toolCalls.id, toolCallId));
      taskIds.push(taskId);
      toolCallIds.push(toolCallId);
      approvalIds.push(approvalId);
      return approvalId;
    },
    async dispose() {
      if (toolCallIds.length)
        await db
          .update(toolCalls)
          .set({ approvalId: null })
          .where(inArray(toolCalls.id, toolCallIds));
      if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
      if (toolCallIds.length) await db.delete(toolCalls).where(inArray(toolCalls.id, toolCallIds));
      if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
      if (policyIds.length)
        await db.delete(approvalPolicies).where(inArray(approvalPolicies.id, policyIds));
      await db.delete(agents).where(eq(agents.id, secondaryId));
      await db.$client.end();
    },
  };
}

it('lists only the owner policies with deterministic filters and ordering', async () => {
  const f = await fixture();
  try {
    const prefix = `policy-test-${randomUUID()}`;
    const disabled = await f.policy(f.ownerId, {
      toolName: `${prefix}.beta`,
      enabled: false,
    });
    const ownerZ = await f.policy(f.ownerId, { toolName: `${prefix}.zeta` });
    const ownerA = await f.policy(f.ownerId, { toolName: `${prefix}.alpha` });
    const secondary = await f.policy(f.secondaryId, { toolName: `${prefix}.alpha` });

    const all = await f.repository.list(f.ownerId);
    const ownIds = [disabled, ownerA, ownerZ];
    expect(
      all.filter((row) => ownIds.includes(row.id as (typeof ownIds)[number])).map((row) => row.id),
    ).toEqual([ownerA, disabled, ownerZ]);
    const enabled = await f.repository.list(f.ownerId, { enabledOnly: true });
    expect(
      enabled
        .filter((row) => ownIds.includes(row.id as (typeof ownIds)[number]))
        .map((row) => row.id),
    ).toEqual([ownerA, ownerZ]);
    expect(
      (await f.repository.list(f.ownerId, { toolName: `${prefix}.alpha` })).map((row) => row.id),
    ).toEqual([ownerA]);
    expect(
      (await f.repository.list(f.secondaryId)).filter((row) => row.id === secondary),
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

it('updates and deletes only owner scoped policies', async () => {
  const f = await fixture();
  try {
    const ownerPolicy = await f.policy(f.ownerId, { toolName: 'test.owner' });
    const otherPolicy = await f.policy(f.secondaryId, { toolName: 'test.other' });
    const [before] = await f.db
      .select({ enabled: approvalPolicies.enabled, updatedAt: approvalPolicies.updatedAt })
      .from(approvalPolicies)
      .where(eq(approvalPolicies.id, ownerPolicy));

    expect(await f.repository.setEnabled(f.secondaryId, ownerPolicy, false)).toBe(false);
    expect(await f.repository.setEnabled(f.ownerId, ownerPolicy, false)).toBe(true);
    const [after] = await f.db
      .select({ enabled: approvalPolicies.enabled, updatedAt: approvalPolicies.updatedAt })
      .from(approvalPolicies)
      .where(eq(approvalPolicies.id, ownerPolicy));
    expect(after?.enabled).toBe(false);
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before?.updatedAt.getTime() ?? 0);

    expect(await f.repository.delete(f.secondaryId, ownerPolicy)).toBe(false);
    expect(await f.repository.delete(f.ownerId, ownerPolicy)).toBe(true);
    expect(await f.repository.delete(f.ownerId, ownerPolicy)).toBe(false);
    const [remainingOther] = await f.db
      .select({ id: approvalPolicies.id })
      .from(approvalPolicies)
      .where(eq(approvalPolicies.id, otherPolicy));
    expect(remainingOther?.id).toBe(otherPolicy);
  } finally {
    await f.dispose();
  }
});

it('preserves historical approval policy IDs after policy deletion', async () => {
  const f = await fixture();
  try {
    const policyId = await f.policy(f.ownerId, { toolName: 'test.historical' });
    const approvalId = await f.historicalApproval(f.ownerId, policyId);
    expect(await f.repository.delete(f.ownerId, policyId)).toBe(true);
    const [approval] = await f.db
      .select({ createdPolicyId: approvals.createdPolicyId })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(approval?.createdPolicyId).toBe(policyId);
  } finally {
    await f.dispose();
  }
});
