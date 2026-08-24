import {
  archiveInactiveGoalRecords,
  createGoalWithWork,
  type GoalInput,
} from '@assistant/application/goals';
import { getApplication, getDb } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

function goalInput(body: unknown): GoalInput | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { error: 'invalid goal body' };
  const value = body as Record<string, unknown>;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title) return { error: 'Title is required.' };
  const priority = typeof value.priority === 'number' ? value.priority : 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
    return { error: 'Priority must be between 1 and 5.' };
  }
  const targetDateValue = value.targetDate;
  let targetDate: Date | null = null;
  if (typeof targetDateValue === 'string' && targetDateValue.trim()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDateValue)) {
      return { error: 'Target date must be YYYY-MM-DD.' };
    }
    targetDate = new Date(`${targetDateValue}T00:00:00Z`);
    if (Number.isNaN(targetDate.getTime())) return { error: 'Target date is not valid.' };
  } else if (targetDateValue != null && targetDateValue !== '') {
    return { error: 'Target date must be YYYY-MM-DD.' };
  }
  const text = (key: string) => (typeof value[key] === 'string' ? value[key].trim() : '');
  return {
    title,
    description: text('description'),
    priority,
    targetDate,
    progress: text('progress'),
    nextAction: text('nextAction'),
    mirrorToPrimary: value.mirrorToPrimary === true,
  };
}

/** Load current or archived goals without delaying the chat bootstrap. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const archived = new URL(request.url).searchParams.get('archived') === 'true';
  return mobileJson(await getApplication().listGoals(archived));
}

/** Creating a mobile goal starts its first work session just like the web form. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = await request.json().catch(() => null);
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body as { action?: unknown }).action === 'archive-inactive'
  ) {
    await archiveInactiveGoalRecords(getDb());
    return mobileJson({ ok: true });
  }
  const input = goalInput(body);
  if ('error' in input) return mobileJson({ error: input.error }, { status: 400 });
  try {
    return mobileJson(await createGoalWithWork(getDb(), input), { status: 201 });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Goal could not be created.' },
      { status: 409 },
    );
  }
}
