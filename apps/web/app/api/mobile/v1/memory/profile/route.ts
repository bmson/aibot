import {
  getVoiceOverview,
  organizeMemoryNow,
  purgeProfileVoiceSamples,
  recompileProfileCard,
  updateVoiceProfile,
} from '@assistant/application/profile';
import { getApplication, getDb, getWorkspace } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const ACTIONS = 'organize, recompile, purge-voice, voice-profile, or forget-all';

/** The distilled writing voice, so the phone can edit the same profile the web does. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const { voiceStats, voiceProfile } = await getVoiceOverview(getDb());
  return mobileJson({ voiceStats, voiceProfile });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
    description?: unknown;
    dos?: unknown;
    donts?: unknown;
    signature?: unknown;
  } | null;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');

  try {
    switch (body?.action) {
      case 'organize':
        return mobileJson({ ok: true, ...(await organizeMemoryNow(getDb())) });
      case 'recompile':
        await recompileProfileCard(getDb());
        return mobileJson({ ok: true });
      case 'purge-voice':
        return mobileJson({
          ok: true,
          ...(await purgeProfileVoiceSamples(getDb(), getWorkspace())),
        });
      case 'voice-profile': {
        const result = await updateVoiceProfile(getDb(), {
          description: text(body.description),
          dos: text(body.dos),
          donts: text(body.donts),
          signature: text(body.signature),
        });
        if (result.error) return mobileJson({ error: result.error }, { status: 400 });
        return mobileJson({ ok: true });
      }
      // Irreversible, and the one action here the owner can never undo, so it
      // stays explicit rather than riding along with purge-voice.
      case 'forget-all':
        await getApplication().forgetLongTermMemory();
        return mobileJson({ ok: true });
      default:
        return mobileJson({ error: `action must be ${ACTIONS}` }, { status: 400 });
    }
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Memory profile could not be updated.' },
      { status: 409 },
    );
  }
}
