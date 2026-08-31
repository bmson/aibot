import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { requireOwner } from '@/auth';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function privateAddress(address: string): boolean {
  if (address === '::1' || address === '0.0.0.0') return true;
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:'))
    return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

export async function GET(request: Request): Promise<Response> {
  await requireOwner();
  const raw = new URL(request.url).searchParams.get('url') ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new Response('Invalid image URL', { status: 400 });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return new Response('Image URL is not allowed', { status: 400 });
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some(({ address }) => privateAddress(address))) {
    return new Response('Image host is not allowed', { status: 400 });
  }
  const upstream = await fetch(url, {
    redirect: 'error',
    headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!upstream?.ok || !upstream.body) return new Response('Image unavailable', { status: 502 });
  const type = upstream.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  const length = Number(upstream.headers.get('content-length') ?? '0');
  if (!ALLOWED_TYPES.has(type) || (length > 0 && length > MAX_BYTES)) {
    return new Response('Unsupported image', { status: 415 });
  }
  const bytes = await upstream.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) return new Response('Image too large', { status: 413 });
  return new Response(bytes, {
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=3600',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
    },
  });
}
