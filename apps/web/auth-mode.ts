export type AuthMode = 'google' | 'dev-bypass' | 'disabled';

/** Resolve auth fail-closed; the bypass must be explicitly enabled and is never valid in prod. */
export function resolveAuthMode(options: {
  googleClientId: string;
  devBypass: boolean;
  nodeEnv: string | undefined;
}): AuthMode {
  if (options.devBypass && options.nodeEnv === 'production') {
    throw new Error('AUTH_DEV_BYPASS must not be enabled in production');
  }
  if (options.googleClientId) return 'google';
  if (!options.devBypass) return 'disabled';
  return 'dev-bypass';
}
