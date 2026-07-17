'use server';

import {
  deleteImportSource,
  detectKind,
  getAgent,
  purgeImportSource,
  reviewImportSource,
  startImport,
} from '@assistant/core';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb, getWorkspace } from '@/lib/server';

function revalidateImport(): void {
  revalidatePath('/import');
  revalidatePath('/profile');
}

/** Start (or re-run) an import for a file already under workspace import/. */
export async function startImportAction(
  workspacePath: string,
  sourceTag: string,
): Promise<{ error?: string }> {
  await requireOwner();
  const db = getDb();
  const agent = await getAgent(db);
  try {
    const content = await getWorkspace().read(workspacePath);
    const kind = detectKind(workspacePath, content.slice(0, 4000));
    await startImport(db, { agentId: agent.id, source: sourceTag, workspacePath, kind });
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
  revalidateImport();
  return {};
}

/** Bound form action: purge every memory this source produced. */
export async function purgeSourceAction(source: string): Promise<void> {
  await requireOwner();
  await purgeImportSource(getDb(), source);
  revalidateImport();
}

/** Remove the source entirely: memories, uploaded file, and the row itself. */
export async function deleteSourceAction(source: string): Promise<void> {
  await requireOwner();
  await deleteImportSource(getDb(), source, getWorkspace());
  revalidateImport();
}

export async function reviewSourceAction(
  source: string,
  verdict: 'approve' | 'reject',
): Promise<void> {
  await requireOwner();
  await reviewImportSource(getDb(), source, verdict);
  revalidateImport();
}
