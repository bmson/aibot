'use server';

import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { getApplication } from '@/lib/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function revalidateAnomalies(): void {
  revalidatePath('/anomalies');
  revalidatePath('/settings');
}

/** Dismiss a false-positive anomaly (raises the effective baseline for frequency). */
export async function dismissAnomalyAction(anomalyId: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(anomalyId)) return;
  await getApplication().dismissAnomaly(anomalyId);
  revalidateAnomalies();
}

/** Suspend the policy behind an anomaly — it stops matching, so its actions park for manual approval. */
export async function suspendPolicyAction(anomalyId: string): Promise<void> {
  await requireOwner();
  if (!UUID_RE.test(anomalyId)) return;
  await getApplication().suspendAnomaly(anomalyId);
  revalidateAnomalies();
}
