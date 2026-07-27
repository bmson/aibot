'use server';

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getApplication } from '@/lib/server';

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
  const result = await getApplication().startImport(workspacePath, sourceTag);
  if (result.error) return result;
  revalidateImport();
  return {};
}

/** Bound form action: purge every memory this source produced. */
export async function purgeSourceAction(source: string): Promise<void> {
  await requireOwner();
  await getApplication().purgeImport(source);
  revalidateImport();
}

/** Remove the source entirely: memories, uploaded file, and the row itself. */
export async function deleteSourceAction(source: string): Promise<void> {
  await requireOwner();
  await getApplication().deleteImport(source);
  revalidateImport();
}

export async function reviewSourceAction(
  source: string,
  verdict: 'approve' | 'reject',
): Promise<void> {
  await requireOwner();
  await getApplication().reviewImport(source, verdict);
  revalidateImport();
}
