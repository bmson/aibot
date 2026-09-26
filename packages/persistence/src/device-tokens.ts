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
  /** Deliverable tokens for one agent, oldest first so a replaced token loses ties. */
  listActive(agentId: string): Promise<ActiveDeviceToken[]>;
  /** APNs said Unregistered (410): stop sending to the token, but keep the row. */
  invalidate(token: string): Promise<void>;
}

export interface ActiveDeviceToken {
  token: string;
  environment: 'sandbox' | 'production';
}
