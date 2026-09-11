import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/**
 * The owner's long-term recall and writing-voice data, as portable JSON.
 *
 * Same payload the web download at /api/profile-export serves. Getting your
 * data out should not depend on which client you happen to be holding, and
 * until this existed a phone-only owner had no way to do it at all.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const payload = await getApplication().exportLongTermMemoryData();
  const filename = `assistant-long-term-memory-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}
