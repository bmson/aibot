'use server';

import { getAgent, purgeDocument } from '@assistant/core';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb, getWorkspace } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Delete a document: its chunks, the row, the file inventory, and the bytes. */
export async function purgeDocumentAction(id: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(id)) return;
  const db = getDb();
  const agent = await getAgent(db);
  await purgeDocument(db, agent.id, id, getWorkspace());
  revalidatePath('/documents');
}
