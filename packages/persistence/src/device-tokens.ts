export interface DeviceTokenRegistrationInput {
  token: string;
  platform: string;
  environment: 'sandbox' | 'production';
}

/** APNs device-token registry for the owner's native app. */
export interface DeviceTokenRepository {
  readonly kind: 'device-token-repository';
  /**
   * Idempotent by token: re-registering refreshes `lastSeenAt`, moves the
   * token to this agent, and revives a token APNs previously invalidated.
   */
  register(agentId: string, registration: DeviceTokenRegistrationInput): Promise<void>;
}
