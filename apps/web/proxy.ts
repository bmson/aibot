import { loadConfig } from '@assistant/config';
import { type NextRequest, NextResponse } from 'next/server';

/** Firestore preview exposes only supported chat, polling, and card-image surfaces. */
export function proxy(request: NextRequest) {
  if (loadConfig().PERSISTENCE_DRIVER !== 'firestore') return NextResponse.next();
  const path = request.nextUrl.pathname;
  const chatPage =
    path === '/chat' ||
    path === '/chat/all' ||
    /^\/chat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path);
  const chatIdPath =
    /^\/api\/mobile\/v1\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const chatMessagePath =
    /^\/api\/mobile\/v1\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    path.startsWith('/api/auth/') ||
    (path === '/api/health' && request.method === 'GET') ||
    (path === '/' && request.method === 'GET') ||
    (chatPage && (request.method === 'GET' || request.method === 'POST')) ||
    (['/icon.svg', '/apple-icon.png', '/favicon.ico', '/manifest.webmanifest'].includes(path) &&
      request.method === 'GET') ||
    ((path === '/api/chat' || path === '/api/mobile/v1/chat') && request.method === 'POST') ||
    ((path === '/api/chat/status' || path === '/api/mobile/v1/chat/status') &&
      request.method === 'GET') ||
    (path === '/api/mobile/v1/bootstrap' && request.method === 'GET') ||
    (path === '/api/card-image' && request.method === 'GET') ||
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
