export type AuthMode = 'google' | 'dev-bypass' | 'disabled';

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Whether a request itself arrived on loopback, judged from its headers.
 *
 * The localhost bypass is validated against *configuration* (AUTH_URL,
 * QUEUE_DRIVER) at boot, but configuration cannot see how the process is
 * published: re-binding the container port to 0.0.0.0 or fronting it with a
 * reverse proxy exposes the same config on the network. A proxied request
 * carries `x-forwarded-*` headers and a direct remote one carries a non-local
 * Host, so both are rejected here per-request.
 */
export function requestLooksLoopback(headers: {
  host: string | null;
  forwardedFor: string | null;
  forwardedHost: string | null;
}): boolean {
  const loopbackName = (value: string): boolean => {
    // Strip the port; IPv6 hosts keep their brackets ([::1]:3000 → [::1]).
    const hostname = value.startsWith('[')
      ? value.replace(/](:\d+)?$/, ']')
      : value.replace(/:\d+$/, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  };
  // Next itself mirrors direct requests into x-forwarded-*, so presence alone
  // proves nothing; a forwarded value naming a non-loopback client or host is
  // what proves the request crossed the network.
  if (headers.forwardedFor !== null) {
    const client = headers.forwardedFor.split(',')[0]?.trim() ?? '';
    if (client !== '127.0.0.1' && client !== '::1' && client !== '::ffff:127.0.0.1') return false;
  }
  if (headers.forwardedHost !== null && !loopbackName(headers.forwardedHost)) return false;
  return loopbackName(headers.host ?? '');
}

/**
 * Resolve auth fail-closed. Development bypass is never valid in production;
 * the separate localhost bypass supports production-built Docker images only
 * when both their URL and queue configuration prove a local installation.
 */
export function resolveAuthMode(options: {
  googleClientId: string;
  devBypass: boolean;
  localhostBypass?: boolean;
  authUrl?: string;
  queueDriver?: 'local' | 'cloudtasks';
  nodeEnv: string | undefined;
}): AuthMode {
  if (options.devBypass && options.nodeEnv === 'production') {
    throw new Error('AUTH_DEV_BYPASS must not be enabled in production');
  }
  if (
    options.localhostBypass &&
    (!isLoopbackUrl(options.authUrl ?? '') || options.queueDriver !== 'local')
  ) {
    throw new Error('AUTH_LOCALHOST_BYPASS requires a loopback AUTH_URL and QUEUE_DRIVER=local');
  }
  if (options.googleClientId) return 'google';
  if (!options.devBypass && !options.localhostBypass) return 'disabled';
  return 'dev-bypass';
}
