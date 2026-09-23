'use server';

import { updateBudgetCaps, updateBudgetCapsWithRepository } from '@assistant/application/costs';
import { loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { createInstallationStore, FirestoreBudgetCapsRepository } from '@assistant/firestore';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getDb } from '@/lib/server';

/** Raise/lower the default task, daily, and monthly hard caps. */
export async function updateCaps(formData: FormData): Promise<void> {
  await requireOwner();
  const values = {
    task_default: String(formData.get('task_default') ?? ''),
    daily: String(formData.get('daily') ?? ''),
    monthly: String(formData.get('monthly') ?? ''),
  };
  const config = loadConfig();
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) throw new Error(problems.join('; '));
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
      databaseId: config.FIRESTORE_DATABASE_ID,
    });
    try {
      await updateBudgetCapsWithRepository(
        new FirestoreBudgetCapsRepository(store),
        config.FIRESTORE_AGENT_ID,
        values,
      );
    } finally {
      await store.db.terminate();
    }
  } else await updateBudgetCaps(getDb(), values);
  revalidatePath('/costs');
}
