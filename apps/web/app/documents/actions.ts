'use server';

import { isModuleEnabled, loadConfig } from '@assistant/config';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getApplication } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Delete a document: its chunks, the row, the file inventory, and the bytes. */
export async function purgeDocumentAction(id: string): Promise<void> {
  await requireOwner();
  if (!isModuleEnabled(loadConfig(), 'documents')) return;
  if (!UUID_RE.test(id)) return;
  await getApplication().deleteDocument(id);
  revalidatePath('/documents');
}
