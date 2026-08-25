import { ApnsClient } from '@assistant/tools/modules/push';
import { defineModule, type ModuleHooks } from '../platform.js';
import { notifyApprovalsByPush, notifyOwnerByPush, type PushChannelDeps } from './channel.js';
import { pushMeta } from './meta.js';

/**
 * A client with no credentials: `configured()` is false and every send is
 * skipped. Declared as the module's `absent` value so the composition root can
 * hold a plain field and callers can query it freely.
 */
const unconfiguredApnsClient = () => new ApnsClient('', '', '', '');

/**
 * APNs owner channel: an owner-notifier leg alongside SMS, so notices and
 * approval pings reach the iOS app even when it is closed. Device tokens
 * arrive through the mobile API (POST /api/mobile/v1/devices); this module
 * only reads them. Self-guards on `configured()` exactly like the SMS channel.
 */
export const pushModule = defineModule<ApnsClient>({
  meta: pushMeta,
  absent: unconfiguredApnsClient,
  create: ({ config, db }) => {
    const client = new ApnsClient(
      config.APNS_KEY_ID,
      config.APNS_TEAM_ID,
      config.APNS_PRIVATE_KEY,
      config.APNS_BUNDLE_ID,
    );
    const channelDeps: PushChannelDeps = { db, apns: client };

    const hooks: ModuleHooks = {
      ownerNotifier: {
        notifyOwner: (input) => notifyOwnerByPush(channelDeps, input),
        notifyApprovals: (approvalsToPing) =>
          notifyApprovalsByPush(channelDeps, [...approvalsToPing]),
      },
    };
    return { exports: client, hooks };
  },
});
