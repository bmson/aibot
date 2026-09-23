import { parseRouteSnapshotQuery, routeSnapshot } from '@assistant/application/maps';
import { isAuthed } from '@/auth';

/** The route card's map image: `?from=lat,lng&to=lat,lng&line=<polyline>&scheme=dark`. */
export async function GET(req: Request) {
  if (!(await isAuthed())) return new Response('unauthorized', { status: 401 });
  const request = parseRouteSnapshotQuery(new URL(req.url).searchParams);
  if (!request) return new Response('invalid route', { status: 400 });
  const result = await routeSnapshot(request);
  if (!result.ok) return new Response(result.error, { status: result.status });
  return new Response(result.body, {
    headers: {
      'content-type': result.contentType,
      'cache-control': 'private, max-age=86400',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
    },
  });
}
