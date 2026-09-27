import { listCalls } from '@assistant/application/calls';
import { getCallsPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Phone calls the assistant placed, newest first. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  return mobileJson({ calls: await listCalls(await getCallsPorts(), 30) });
}
