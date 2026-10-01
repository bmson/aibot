'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwner } from '@/auth';
import { decideOwnerRepair, reportOwnerRepair } from '@/lib/self-repair-server';
export async function reportRepairAction(form: FormData) {
  await requireOwner();
  const input = z
    .object({
      title: z.string().trim().min(3).max(200),
      summary: z.string().trim().min(5).max(3000),
      sourceTaskId: z.string().uuid().optional(),
    })
    .parse({
      title: form.get('title'),
      summary: form.get('summary'),
      sourceTaskId: form.get('sourceTaskId') || undefined,
    });
  await reportOwnerRepair(input.title, input.summary, input.sourceTaskId);
  revalidatePath('/improvements');
}
export async function repairDecisionAction(
  id: string,
  action: 'dismiss' | 'retry' | 'resolve' | 'run_now',
) {
  await requireOwner();
  z.string().uuid().parse(id);
  z.enum(['dismiss', 'retry', 'resolve', 'run_now']).parse(action);
  await decideOwnerRepair(id, action);
  revalidatePath('/improvements');
}
