import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@assistant/config';
import {
  createDb,
  type Db,
  knowledgeGraphRelations,
  knowledgeGraphSources,
  memories,
  messages,
  responseChecks,
  tasks,
  toolCalls,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';

export const CARNAVAL_REPAIR_ID = '2026-08-29-carnaval-grounding-v1';
export const CARNAVAL_CONVERSATION_ID = '8d6f0df5-a347-4fc7-90b3-125bda578535';
export const CARNAVAL_CORRECTION_CHANNEL_ID = `repair:${CARNAVAL_REPAIR_ID}`;
export const CARNAVAL_MEMORY_ID = 'c101aef8-3102-41e6-a30b-1755c9ff4e1a';
export const CARNAVAL_RELATION_ID = '5081fd49-8705-4698-bad0-e9707109782f';

const INCIDENT_MESSAGES = [
  {
    id: '39164ecd-ef8e-48b9-b213-eab80e91e5ba',
    taskId: 'c60d57d1-975f-4b4a-8d59-494524f75953',
    sha256: '233d4a0b342d1d849dc82f27f8f653aa81ae5dd497f13580d60cefa20b140b0e',
    reason: 'The attendance history was not supported by the saved source data.',
  },
  {
    id: '5a29d932-2c22-4103-97cc-17e6c3b52ca2',
    taskId: 'af9b52f0-278c-4441-8fa0-3bb5f8deeec8',
    sha256: 'fa2501b5ecc71661ab2e23b6eabed9cb5c2677e4b748061b52c0fe85a08fed5c',
    reason: 'The graph invented events and evidence that do not exist in the active memory graph.',
  },
  {
    id: 'dd397a2d-8583-4977-aa66-5963c5e75241',
    taskId: 'efe7fb43-e613-4588-af6f-be0018e6fb89',
    sha256: '03e4d00ca609331ab61225c06148345c8d6c1868cc4ad993ee91894c5a6f2f9d',
    reason: 'The capability statement was incorrect; connected Drive search is available.',
  },
  {
    id: 'b3016507-0ddd-4f44-b61a-4d977320ed23',
    taskId: '417b3bcc-e536-4036-b493-9a1e396da62c',
    sha256: '8464ff224ec9d1f04b00ba11abfc3bc36b1e7e3f03629277494592a761d4469b',
    reason: 'Duplicate calendar representations were mislabeled as separate conflicts.',
  },
  {
    id: '72fb325d-0ca0-47df-bd87-f5e2315fdf48',
    taskId: '59d24c1f-cd43-404d-a605-f10f5a351a9c',
    sha256: '30c718456ad1e3a09b6e024eac407cb17b9d2dd07467909b530d7e63d3a32587',
    reason: 'A scheduled reminder incorrectly inherited stale photo-search context.',
  },
  {
    id: '07e8ed15-6412-4eec-973f-f2f62212fa04',
    taskId: 'c55c2635-4e38-4f5a-94c6-f73be4806b00',
    sha256: '40e6fc4f071c32df52f84a3dc776d43311143f60243cf30e3df1ce621c5e2cd3',
    reason: 'The filenames, metadata, and Drive links were fabricated without a tool result.',
  },
] as const;

const CORRECTION_TEXT = [
  'Correction after checking the saved source and completed tool records:',
  '',
  '- The only source-backed Carnaval attendance I found is May 25, 2014, near Harrison Street between 16th and 24th Streets in San Francisco. The imported memory has 60% confidence and has not been owner-confirmed.',
  '- The active memory graph contains one supported connection: Owner — attended → Carnival Parade, backed by that same 2014 memory. It does not support the earlier claims about 2023, 2024, 2026, or 2027.',
  '- The completed Drive search returned zero files. The later filenames, metadata, and Drive links were fabricated and have been retracted.',
  '- The two reported soccer “conflicts” were duplicate representations of the same matches across calendars, not separate overlapping events.',
  '- The scheduled reminder should have said: “Get sunglasses from the car and pack them.” It incorrectly inherited the prior photo-search context.',
  '',
  'I retracted the six unsupported or incorrect responses above. Each retraction can be expanded to inspect its original text.',
].join('\n');

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function retractionText(reason: string): string {
  return `This response was retracted. ${reason} See the source-backed correction below.`;
}

function retractionPart(part: unknown): Record<string, unknown> | null {
  if (!part || typeof part !== 'object') return null;
  const value = part as Record<string, unknown>;
  return value.type === 'notice' && value.notice === 'retracted' ? value : null;
}

export async function inspectCarnavalIncident(db: Db) {
  const ids = INCIDENT_MESSAGES.map((message) => message.id);
  const taskIds = INCIDENT_MESSAGES.map((message) => message.taskId);
  const [
    affectedMessages,
    linkedTasks,
    linkedToolCalls,
    linkedChecks,
    sourceMemory,
    sourceCheckpoint,
    sourceRelation,
    correction,
  ] = await Promise.all([
    db.select().from(messages).where(inArray(messages.id, ids)),
    db.select().from(tasks).where(inArray(tasks.id, taskIds)),
    db.select().from(toolCalls).where(inArray(toolCalls.taskId, taskIds)),
    db.select().from(responseChecks).where(inArray(responseChecks.taskId, taskIds)),
    db.select().from(memories).where(eq(memories.id, CARNAVAL_MEMORY_ID)),
    db
      .select()
      .from(knowledgeGraphSources)
      .where(eq(knowledgeGraphSources.memoryId, CARNAVAL_MEMORY_ID)),
    db
      .select()
      .from(knowledgeGraphRelations)
      .where(eq(knowledgeGraphRelations.id, CARNAVAL_RELATION_ID)),
    db.select().from(messages).where(eq(messages.channelMessageId, CARNAVAL_CORRECTION_CHANNEL_ID)),
  ]);

  return {
    affectedMessages,
    linkedTasks,
    linkedToolCalls,
    linkedChecks,
    sourceMemory,
    sourceCheckpoint,
    sourceRelation,
    correction,
  };
}

function assertIncident(
  snapshot: Awaited<ReturnType<typeof inspectCarnavalIncident>>,
): 'ready' | 'already-applied' {
  if (snapshot.correction.length > 1)
    throw new Error('Repair guard failed: duplicate correction rows exist.');
  if (snapshot.affectedMessages.length !== INCIDENT_MESSAGES.length) {
    throw new Error(
      `Repair guard failed: expected ${INCIDENT_MESSAGES.length} target messages, found ${snapshot.affectedMessages.length}.`,
    );
  }
  const alreadyRetracted = snapshot.affectedMessages.filter(
    (row) => Array.isArray(row.parts) && row.parts.some((part) => retractionPart(part) !== null),
  );
  if (alreadyRetracted.length > 0) {
    if (alreadyRetracted.length === INCIDENT_MESSAGES.length && snapshot.correction.length === 1) {
      for (const expected of INCIDENT_MESSAGES) {
        const row = alreadyRetracted.find((message) => message.id === expected.id);
        const notice = Array.isArray(row?.parts)
          ? row.parts.map(retractionPart).find((part) => part !== null)
          : null;
        if (
          !row ||
          row.text !== retractionText(expected.reason) ||
          notice?.repairId !== CARNAVAL_REPAIR_ID ||
          notice.reason !== expected.reason ||
          typeof notice.originalText !== 'string' ||
          digest(notice.originalText) !== expected.sha256
        ) {
          throw new Error(`Repair guard failed: invalid retraction for message ${expected.id}.`);
        }
      }
      return 'already-applied';
    }
    throw new Error('Repair guard failed: incident is only partially repaired.');
  }

  if (
    snapshot.linkedTasks.length !== INCIDENT_MESSAGES.length ||
    INCIDENT_MESSAGES.some(
      (expected) =>
        !snapshot.linkedTasks.some(
          (task) =>
            task.id === expected.taskId &&
            (task.conversationId === null || task.conversationId === CARNAVAL_CONVERSATION_ID),
        ),
    )
  ) {
    throw new Error('Repair guard failed: linked task ownership changed.');
  }

  for (const expected of INCIDENT_MESSAGES) {
    const actual = snapshot.affectedMessages.find((row) => row.id === expected.id);
    if (!actual) throw new Error(`Repair guard failed: missing message ${expected.id}.`);
    if (actual.conversationId !== CARNAVAL_CONVERSATION_ID || actual.taskId !== expected.taskId) {
      throw new Error(`Repair guard failed: ownership changed for message ${expected.id}.`);
    }
    if (actual.role !== 'assistant' || digest(actual.text) !== expected.sha256) {
      throw new Error(`Repair guard failed: content changed for message ${expected.id}.`);
    }
  }

  const memory = snapshot.sourceMemory[0];
  if (
    snapshot.sourceMemory.length !== 1 ||
    memory?.content !==
      'Owner attended the Carnival Parade on May 25, 2014, in the Harrison Street and 16th to 24th area of San Francisco.' ||
    memory.source !== 'baldvin-and-katie-calendar' ||
    memory.confidence !== '0.60' ||
    memory.ownerConfirmed
  ) {
    throw new Error('Repair guard failed: the cited source memory changed.');
  }
  const checkpoint = snapshot.sourceCheckpoint[0];
  const relation = snapshot.sourceRelation[0];
  if (
    snapshot.sourceCheckpoint.length !== 1 ||
    checkpoint?.status !== 'ready' ||
    snapshot.sourceRelation.length !== 1 ||
    relation?.sourceMemoryId !== CARNAVAL_MEMORY_ID ||
    relation.predicate !== 'attended' ||
    relation.reviewStatus === 'rejected' ||
    !relation.evidenceQuote
  ) {
    throw new Error('Repair guard failed: the active source-backed graph connection changed.');
  }
  const driveCalls = snapshot.linkedToolCalls.filter((row) => row.toolName === 'drive.search');
  if (
    driveCalls.length !== 1 ||
    driveCalls[0]?.taskId !== '59d24c1f-cd43-404d-a605-f10f5a351a9c' ||
    driveCalls[0].status !== 'succeeded' ||
    !driveCalls[0].result ||
    !Array.isArray((driveCalls[0].result as Record<string, unknown>).files) ||
    ((driveCalls[0].result as Record<string, unknown>).files as unknown[]).length !== 0
  ) {
    throw new Error(
      'Repair guard failed: expected exactly one completed zero-result Drive search.',
    );
  }
  if (snapshot.correction.length !== 0) {
    throw new Error(
      'Repair guard failed: a correction row already exists without full retractions.',
    );
  }
  return 'ready';
}

export async function repairCarnavalIncident(
  db: Db,
  options: { apply: boolean; backupPath?: string },
): Promise<{ status: 'dry-run' | 'applied' | 'already-applied'; backupPath?: string }> {
  const snapshot = await inspectCarnavalIncident(db);
  const state = assertIncident(snapshot);
  if (state === 'already-applied') return { status: 'already-applied' };
  if (!options.apply) return { status: 'dry-run' };
  if (!options.backupPath) throw new Error('An explicit backup path is required when applying.');

  const backupPath = resolve(options.backupPath);
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(
    backupPath,
    `${JSON.stringify({ repairId: CARNAVAL_REPAIR_ID, createdAt: new Date().toISOString(), ...snapshot }, null, 2)}\n`,
    { flag: 'wx' },
  );

  await db.transaction(async (tx) => {
    const current = await inspectCarnavalIncident(tx as unknown as Db);
    if (assertIncident(current) !== 'ready')
      throw new Error('Repair changed before transaction start.');
    for (const expected of INCIDENT_MESSAGES) {
      const actual = current.affectedMessages.find((row) => row.id === expected.id);
      if (!actual) throw new Error(`Repair target disappeared: ${expected.id}`);
      const safeText = retractionText(expected.reason);
      await tx
        .update(messages)
        .set({
          text: safeText,
          embedding: null,
          parts: [
            { type: 'text', text: safeText },
            {
              type: 'notice',
              notice: 'retracted',
              reason: expected.reason,
              originalText: actual.text,
              repairId: CARNAVAL_REPAIR_ID,
            },
          ],
        })
        .where(eq(messages.id, expected.id));
    }
    await tx
      .insert(messages)
      .values({
        conversationId: CARNAVAL_CONVERSATION_ID,
        role: 'assistant',
        origin: 'assistant',
        channelMessageId: CARNAVAL_CORRECTION_CHANNEL_ID,
        text: CORRECTION_TEXT,
        parts: [
          { type: 'text', text: CORRECTION_TEXT },
          {
            type: 'recall',
            sources: [
              {
                date: 'May 25, 2014',
                label: 'Baldvin and Katie calendar import',
                kind: 'knowledge_graph',
                hops: 1,
              },
            ],
          },
        ],
      })
      .onConflictDoNothing();
  });

  const repaired = await inspectCarnavalIncident(db);
  if (assertIncident(repaired) !== 'already-applied') {
    throw new Error('Repair verification failed after commit.');
  }
  return { status: 'applied', backupPath };
}

async function main() {
  const config = loadConfig();
  const apply = process.argv.includes('--apply');
  const production = process.argv.includes('--production');
  const incidentArg = process.argv.find((argument) => argument.startsWith('--incident='));
  if (apply && (!production || incidentArg !== `--incident=${CARNAVAL_REPAIR_ID}`)) {
    throw new Error(
      `Applying requires --production --incident=${CARNAVAL_REPAIR_ID}. Dry-run first.`,
    );
  }
  const databaseUrl = production ? config.PROD_DATABASE_URL : config.DATABASE_URL;
  if (!databaseUrl)
    throw new Error(production ? 'PROD_DATABASE_URL is required.' : 'DATABASE_URL is required.');
  const backupArg = process.argv.find((argument) => argument.startsWith('--backup='));
  const backupPath =
    backupArg?.slice('--backup='.length) ??
    `.workspace/backups/${CARNAVAL_REPAIR_ID}-${new Date().toISOString().replaceAll(':', '-')}.json`;
  const db = createDb(databaseUrl, { max: 1 });
  try {
    const result = await repairCarnavalIncident(db, { apply, backupPath });
    console.log(
      result.status === 'dry-run'
        ? 'Dry run passed: six exact messages, their task evidence, and the 2014 source-backed graph connection match the incident manifest.'
        : result.status === 'already-applied'
          ? 'Repair already applied; no rows changed.'
          : `Repair applied and verified. Backup: ${result.backupPath}`,
    );
  } finally {
    await db.$client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
