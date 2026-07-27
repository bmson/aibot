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
