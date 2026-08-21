import { getApplication } from '@/lib/server';
import { isMobileAuthed, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

/** Preserve the AI SDK event stream and routing headers for the Swift client. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  return getApplication().handleChatTurn(request);
}
