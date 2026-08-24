import {
  organizeMemoryNow,
  purgeProfileVoiceSamples,
  recompileProfileCard,
} from '@assistant/application/profile';
import { getDb, getWorkspace } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  try {
    if (body?.action === 'organize') {
      return mobileJson({ ok: true, ...(await organizeMemoryNow(getDb())) });
    }
    if (body?.action === 'recompile') await recompileProfileCard(getDb());
    else if (body?.action === 'purge-voice') {
      return mobileJson({ ok: true, ...(await purgeProfileVoiceSamples(getDb(), getWorkspace())) });
    } else if (body?.action !== 'recompile') {
      return mobileJson(
        { error: 'action must be organize, recompile, or purge-voice' },
        { status: 400 },
      );
    }
    return mobileJson({ ok: true });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Memory profile could not be updated.' },
      { status: 409 },
    );
  }
}
