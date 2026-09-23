import { loadConfig } from '@assistant/config';
import { type NextRequest, NextResponse } from 'next/server';

/** Firestore preview exposes only authenticated chat ingress and polling. */
export function proxy(request: NextRequest) {
  if (loadConfig().PERSISTENCE_DRIVER !== 'firestore') return NextResponse.next();
  const path = request.nextUrl.pathname;
  if (
    path.startsWith('/api/auth/') ||
    (path === '/api/health' && request.method === 'GET') ||
    ((path === '/api/chat' || path === '/api/mobile/v1/chat') && request.method === 'POST') ||
    ((path === '/api/chat/status' || path === '/api/mobile/v1/chat/status') &&
      request.method === 'GET')
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
