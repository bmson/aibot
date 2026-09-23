import { loadConfig } from '@assistant/config';
import { type NextRequest, NextResponse } from 'next/server';

/** Firestore preview exposes only supported read surfaces, chat, polling, and card images. */
export function proxy(request: NextRequest) {
  if (loadConfig().PERSISTENCE_DRIVER !== 'firestore') return NextResponse.next();
  const path = request.nextUrl.pathname;
  const chatPage =
    path === '/chat' ||
    path === '/chat/all' ||
    /^\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path);
  const chatIdPath =
    /^\/api\/mobile\/v1\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const activityIdPath =
    /^\/api\/mobile\/v1\/activity\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const skillIdPath =
    /^\/api\/mobile\/v1\/skills\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const personOccasionsPath =
    /^\/api\/mobile\/v1\/memory\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/occasions$/i;
  const chatMessagePath =
    /^\/api\/mobile\/v1\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    path.startsWith('/api/auth/') ||
    (path === '/api/health' && request.method === 'GET') ||
    (path === '/' && request.method === 'GET') ||
    (path === '/profile/memories' && request.method === 'GET') ||
    (path === '/people' && request.method === 'GET') ||
    (/^\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path) &&
      request.method === 'GET') ||
    (path === '/profile/data' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/profile-export' && request.method === 'GET') ||
    (path === '/api/mobile/v1/memory/export' && request.method === 'GET') ||
    (path === '/capabilities' && request.method === 'GET') ||
    (path === '/costs' && request.method === 'GET') ||
    (path === '/profile/voice' && request.method === 'GET') ||
    (path === '/profile/about' && request.method === 'GET') ||
    (path === '/settings' && request.method === 'GET') ||
    (path === '/import' && request.method === 'GET') ||
    (path === '/skills' && request.method === 'GET') ||
    (chatPage && (request.method === 'GET' || request.method === 'POST')) ||
    (['/icon.svg', '/apple-icon.png', '/favicon.ico', '/manifest.webmanifest'].includes(path) &&
      request.method === 'GET') ||
    ((path === '/api/chat' || path === '/api/mobile/v1/chat') && request.method === 'POST') ||
    ((path === '/api/chat/status' || path === '/api/mobile/v1/chat/status') &&
      request.method === 'GET') ||
    (path === '/api/shell/status' && request.method === 'GET') ||
    (path === '/api/mobile/v1/bootstrap' && request.method === 'GET') ||
    (path === '/api/mobile/v1/activity' && request.method === 'GET') ||
    (activityIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/skills' && request.method === 'POST') ||
    (skillIdPath.test(path) && ['POST', 'PATCH', 'DELETE'].includes(request.method)) ||
    (path === '/api/mobile/v1/workspace' && request.method === 'GET') ||
    (path === '/api/mobile/v1/costs' && request.method === 'PATCH') ||
    (path === '/api/mobile/v1/memory/profile' && request.method === 'GET') ||
    (personOccasionsPath.test(path) && request.method === 'POST') ||
    (path === '/api/card-image' && request.method === 'GET') ||
    (path === '/api/mobile/v1/cards' && request.method === 'GET') ||
    (/^\/api\/mobile\/v1\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'GET') ||
    (path === '/api/mobile/v1/memory/library' && request.method === 'GET') ||
    (path === '/api/mobile/v1/people' && request.method === 'GET') ||
    (path === '/api/mobile/v1/memory/commitments' && request.method === 'GET') ||
    (path === '/api/mobile/v1/settings' && request.method === 'PATCH') ||
    (/^\/api\/mobile\/v1\/settings\/reminders\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'DELETE') ||
    (path === '/api/mobile/v1/chats' && request.method === 'POST') ||
    (chatIdPath.test(path) && ['GET', 'POST'].includes(request.method)) ||
    (chatMessagePath.test(path) && request.method === 'POST')
  ) {
    return NextResponse.next();
  }
  return Response.json(
    { error: 'This web surface is unavailable in Firestore mode.', code: 'unavailable' },
    { status: 503 },
  );
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
