import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<ResolvedAddress[]>;

async function resolveWithDeadline(
  resolver: HostResolver,
  hostname: string,
): Promise<ResolvedAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolver(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS resolution timed out')), 5_000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function privateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const tail = lower.slice('::ffff:'.length);
  if (isIP(tail) === 4) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2) return null;
  const high = Number.parseInt(parts[0] ?? '', 16);
  const low = Number.parseInt(parts[1] ?? '', 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function privateIpv6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0] ?? '';
  const mapped = mappedIpv4(lower);
  if (mapped) return privateIpv4(mapped);
  const words = lower.split(':');
  const first = Number.parseInt(words[0] ?? '', 16);
  const second = Number.parseInt(words[1] || '0', 16);
  const third = Number.parseInt(words[2] || '0', 16);
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) return true;
  if (first === 0x2002) return true; // 6to4 can tunnel to private IPv4
  if (first !== 0x2001) return false;
  if (second === 0 || second === 0x0db8) return true; // Teredo/special + documentation
  if (second === 2 && third === 0) return true; // benchmarking
  if ((second & 0xfff0) === 0x10 || (second & 0xfff0) === 0x20) return true; // ORCHID
  return false;
}

export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !privateIpv4(address);
  if (version === 6) return !privateIpv6(address);
  return false;
}

/** Resolve once, reject mixed/private answers, and return the exact addresses callers must pin. */
export async function resolvePublicHost(
  hostname: string,
  resolver: HostResolver = lookup as HostResolver,
): Promise<ResolvedAddress[]> {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized === 'metadata' ||
    normalized === 'metadata.google.internal'
  ) {
    throw new Error('private hosts are blocked');
  }
  const literalVersion = isIP(normalized);
  const addresses = literalVersion
    ? [{ address: normalized, family: literalVersion }]
    : await resolveWithDeadline(resolver, normalized);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('private or unresolved hosts are blocked');
  }
  return addresses;
}

/** Validate both the URL and every current DNS answer before Chromium sees it. */
export async function assertPublicHttpUrl(
  raw: string,
  resolver: HostResolver = lookup as HostResolver,
): Promise<URL> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http(s) only');
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== expectedPort) throw new Error('nonstandard web ports are blocked');

  await resolvePublicHost(url.hostname, resolver);
  return url;
}
