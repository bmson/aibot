/** What the proactive pipeline received and sent, for the owner's "Noticing" panel. */
export interface ProactiveHealthCounts {
  mailScored24h: number;
  mailScored7d: number;
  lastMailAt: Date | null;
  momentsDelivered24h: number;
  pingsDelivered24h: number;
  pingsHeld24h: number;
  /** Registered, non-invalidated push devices. */
  pushDevices: number;
}

/** The counts behind the proactive-health view. The warnings stay in core. */
export interface ProactiveHealthRepository {
  readonly kind: 'proactive-health-repository';
  counts(
    agentId: string,
    window: { since24h: Date; since7d: Date },
  ): Promise<ProactiveHealthCounts>;
}
