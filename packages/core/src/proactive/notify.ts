/**
 * The one shape a proactive producer uses to reach the owner.
 *
 * Producers post their own dashboard copy (`postOwnerNotice`) and then call
 * this for the phone leg, passing the conversation they already wrote to so
 * the dashboard notifier skips mirroring a second copy. It is deliberately the
 * same input shape as the executor's `notifyOwner` dep, so the composition
 * root satisfies both with one function.
 *
 * `urgency: 'ambient'` is the point of it: proactive notices are things the
 * owner did NOT just ask for, so quiet hours and the daily cap
 * (`evaluateOutOfBandPing`) govern whether the phone buzzes. A held ping is
 * never a lost one — the dashboard copy is already posted.
 */
export type ProactiveNotifier = (input: {
  taskId?: string;
  conversationId: string | null;
  text: string;
  urgency?: 'ambient' | 'interrupt';
}) => Promise<void>;

/**
 * Send a phone leg without letting a channel outage break the producer.
 *
 * Every caller here has already persisted the owner-visible copy, so a failed
 * ping costs the buzz and nothing else. Returns whether the leg was attempted
 * and succeeded, which the job summaries report.
 */
export async function pingOwner(
  notify: ProactiveNotifier | undefined,
  input: { taskId?: string; conversationId: string | null; text: string },
): Promise<boolean> {
  if (!notify) return false;
  return notify({ ...input, urgency: 'ambient' })
    .then(() => true)
    .catch((err) => {
      console.error('proactive ping failed', err);
      return false;
    });
}
