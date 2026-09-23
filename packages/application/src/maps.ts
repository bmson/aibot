import { loadConfig } from '@assistant/config';
import { decodePolyline, mapKitCredentials, routeSnapshotUrl } from '@assistant/core/maps';

/**
 * The static map behind the web route card. The browser asks this service for
 * a picture of a route it already holds (both ends and the encoded line); the
 * service signs a Maps Web Snapshots URL with the server's key and returns the
 * image, so the key never leaves the server and the page's CSP stays
 * same-origin.
 */

export interface RouteSnapshotRequest {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  line: string;
  scheme: 'light' | 'dark';
}

const COORD = /^(-?\d{1,2}(?:\.\d{1,7})?),(-?\d{1,3}(?:\.\d{1,7})?)$/;

function coordinate(value: string | null): { lat: number; lng: number } | undefined {
  const match = COORD.exec(value ?? '');
  if (!match) return undefined;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
}

export function parseRouteSnapshotQuery(params: URLSearchParams): RouteSnapshotRequest | undefined {
  const from = coordinate(params.get('from'));
  const to = coordinate(params.get('to'));
  const line = params.get('line') ?? '';
  // Encoded-polyline alphabet only, and short enough to stay under Apple's
  // URL limit; it must also decode to real coordinates.
  if (!from || !to || !/^[\x3f-\x7e]{2,2000}$/.test(line)) return undefined;
  const points = decodePolyline(line);
  if (!points.length || points.some((p) => Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180))
    return undefined;
  return { from, to, line, scheme: params.get('scheme') === 'dark' ? 'dark' : 'light' };
}

export type RouteSnapshotResult =
  | { ok: true; body: ArrayBuffer; contentType: string }
  | { ok: false; status: 404 | 502; error: string };

export async function routeSnapshot(
  request: RouteSnapshotRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RouteSnapshotResult> {
  const credentials = mapKitCredentials(loadConfig());
  if (!credentials) return { ok: false, status: 404, error: 'Maps are not configured.' };
  const url = routeSnapshotUrl(
    credentials,
    { origin: request.from, destination: request.to, polyline: request.line },
    { colorScheme: request.scheme },
  );
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
  const contentType = response?.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!response?.ok || contentType !== 'image/png') {
    console.error('route snapshot failed', response?.status);
    return { ok: false, status: 502, error: 'The map could not be drawn.' };
  }
  return { ok: true, body: await response.arrayBuffer(), contentType };
}
