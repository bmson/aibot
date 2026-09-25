import { loadConfig } from '@assistant/config';
import { type NextRequest, NextResponse } from 'next/server';

/** Firestore preview exposes migrated read surfaces and the supported owner mutations. */
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
  const anomalyIdPath =
    /^\/api\/mobile\/v1\/anomalies\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const documentIdPath =
    /^\/api\/mobile\/v1\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const suggestionIdPath =
    /^\/api\/mobile\/v1\/suggestions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const skillIdPath =
    /^\/api\/mobile\/v1\/skills\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const personOccasionsPath =
    /^\/api\/mobile\/v1\/memory\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/occasions$/i;
  const memoryPersonPath =
    /^\/api\/mobile\/v1\/memory\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const memoryOccasionPath =
    /^\/api\/mobile\/v1\/memory\/occasions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const approvalIdPath =
    /^\/api\/mobile\/v1\/approvals\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const improvementIdPath =
    /^\/api\/mobile\/v1\/improvements\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const cardIdPath =
    /^\/api\/mobile\/v1\/cards\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const chatMessagePath =
    /^\/api\/mobile\/v1\/chats\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/messages\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    path.startsWith('/api/auth/') ||
    // Passkey owner auth; each route returns 404 unless OWNER_AUTH_MODE=passkey.
    (path.startsWith('/api/owner/') && ['GET', 'POST', 'DELETE'].includes(request.method)) ||
    (['/setup', '/signin', '/security'].includes(path) && request.method === 'GET') ||
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
    // Anomaly and improvement review: owner-authenticated pages and actions.
    ((path === '/anomalies' || path === '/improvements') &&
      ['GET', 'POST'].includes(request.method)) ||
    // The POST is the costs page's Server Action; it performs its own owner
    // authentication and Firestore persistence checks before changing caps.
    (path === '/costs' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/profile/voice' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/profile/about' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/cards' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/packs' && ['GET', 'POST'].includes(request.method)) ||
    // Settings Server Actions recheck owner auth; Firestore supports the
    // assistant identity and notification preference updates.
    (path === '/settings' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/goals' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/import' && request.method === 'GET') ||
    (path === '/skills' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/approvals' && ['GET', 'POST'].includes(request.method)) ||
    // Activity pages and their Server Actions enforce owner authentication
    // before reading or changing task records.
    (path === '/tasks' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path) &&
      ['GET', 'POST'].includes(request.method)) ||
    (chatPage && (request.method === 'GET' || request.method === 'POST')) ||
    (['/icon.svg', '/apple-icon.png', '/favicon.ico', '/manifest.webmanifest'].includes(path) &&
      request.method === 'GET') ||
    ((path === '/api/chat' || path === '/api/mobile/v1/chat') && request.method === 'POST') ||
    ((path === '/api/chat/status' || path === '/api/mobile/v1/chat/status') &&
      request.method === 'GET') ||
    (path === '/api/shell/status' && request.method === 'GET') ||
    (path === '/api/mobile/v1/bootstrap' && request.method === 'GET') ||
    (path === '/api/mobile/v1/activity' && request.method === 'GET') ||
    (path === '/api/mobile/v1/activity' && request.method === 'POST') ||
    (path === '/api/mobile/v1/activity/foreground' && request.method === 'POST') ||
    (path === '/api/mobile/v1/location' && request.method === 'POST') ||
    (path === '/api/mobile/v1/goals' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/mcp' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/mcp\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['POST', 'DELETE'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/goals\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['GET', 'PATCH', 'POST'].includes(request.method)) ||
    (activityIdPath.test(path) && request.method === 'POST') ||
    (anomalyIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/skills' && request.method === 'POST') ||
    (skillIdPath.test(path) && ['POST', 'PATCH', 'DELETE'].includes(request.method)) ||
    (path === '/api/mobile/v1/workspace' && request.method === 'GET') ||
    (path === '/api/mobile/v1/overview' && request.method === 'GET') ||
    (path === '/api/mobile/v1/documents' && ['GET', 'POST'].includes(request.method)) ||
    (documentIdPath.test(path) && ['GET', 'DELETE'].includes(request.method)) ||
    (suggestionIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/costs' && request.method === 'PATCH') ||
    (approvalIdPath.test(path) && request.method === 'POST') ||
    (improvementIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/memory/profile' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/memory/people' && request.method === 'POST') ||
    (memoryPersonPath.test(path) && ['GET', 'PATCH', 'POST', 'DELETE'].includes(request.method)) ||
    // Owner memory commands: create, correct, confirm, forget, and review.
    (path === '/api/mobile/v1/memory' && request.method === 'POST') ||
    (/^\/api\/mobile\/v1\/memory\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['PATCH', 'POST'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/knowledge\/sources\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['PATCH', 'DELETE'].includes(request.method)) ||
    (memoryOccasionPath.test(path) && ['POST', 'PATCH', 'DELETE'].includes(request.method)) ||
    (personOccasionsPath.test(path) && request.method === 'POST') ||
    (path === '/api/card-image' && request.method === 'GET') ||
    (path === '/api/mobile/v1/cards' && request.method === 'GET') ||
    (cardIdPath.test(path) && request.method === 'POST') ||
    (path === '/api/mobile/v1/packs' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/people\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'GET') ||
    (path === '/api/mobile/v1/memory/library' && request.method === 'GET') ||
    (path === '/api/mobile/v1/knowledge' && ['GET', 'POST'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/knowledge\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'GET') ||
    (/^\/api\/mobile\/v1\/knowledge\/relations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['GET', 'POST', 'DELETE'].includes(request.method)) ||
    (path === '/api/mobile/v1/people' && request.method === 'GET') ||
    (path === '/api/mobile/v1/memory/commitments' && ['GET', 'POST'].includes(request.method)) ||
    (path === '/api/mobile/v1/settings' && request.method === 'PATCH') ||
    (/^\/api\/mobile\/v1\/settings\/reminders\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'DELETE') ||
    (/^\/api\/mobile\/v1\/settings\/policies\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      ['POST', 'DELETE'].includes(request.method)) ||
    (/^\/api\/mobile\/v1\/settings\/schedules\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      path,
    ) &&
      request.method === 'POST') ||
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
