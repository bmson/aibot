import { loadVoiceContext, rewriteInVoice } from '@assistant/core';
import { registerSmsTools, TwilioClient } from '@assistant/tools/modules/sms';
import { defineModule, type ModuleHooks } from '../platform.js';
import {
  deliverSmsFinal,
  handleInboundSms,
  notifyApprovalsBySms,
  notifyOwnerBySms,
  type SmsChannelDeps,
} from './channel.js';
import { smsMeta } from './meta.js';

/**
 * A client with no credentials: `configured()` is false and every send is
 * refused. Declared as the module's `absent` value so the
 * composition root can hold a plain field and callers can query it freely.
 */
const unconfiguredTwilioClient = () => new TwilioClient('', '', '');

export const smsModule = defineModule<TwilioClient>({
  meta: smsMeta,
  absent: unconfiguredTwilioClient,
  create: ({ config, db, registry, router }) => {
    const client = new TwilioClient(
      config.TWILIO_ACCOUNT_SID,
      config.TWILIO_AUTH_TOKEN,
      config.TWILIO_FROM_NUMBER,
    );
    const channelDeps: SmsChannelDeps = { config, db, registry, twilio: client };

    // The channel hooks exist on the unconfigured branch too: routes must
    // answer (the webhook 404s only when the module is DISABLED, not when it
    // is missing credentials), and every deliverer self-guards on
    // `configured()` — exactly the behavior the agent had when these were
    // hardcoded.
    const hooks: ModuleHooks = {
      ownerNotifier: {
        notifyOwner: (input) => notifyOwnerBySms(channelDeps, input),
        notifyApprovals: (approvalsToPing) =>
          notifyApprovalsBySms(channelDeps, [...approvalsToPing]),
      },
      channel: {
        assertDeliverable: (task) => {
          if (task.type === 'sms_turn' && task.trust === 'owner' && !client.configured()) {
            throw new Error('SMS final delivery is not configured');
          }
        },
        deliverFinal: (_services, task, text) =>
          deliverSmsFinal(
            channelDeps,
            { id: task.id, conversationId: task.conversationId, trust: task.trust },
            text,
          ),
      },
      webhooks: [
        {
          path: '/twilio/sms',
          handler: async (_services, request) => {
            const params = await request.form();
            await handleInboundSms(channelDeps, {
              messageSid: params.MessageSid ?? '',
              from: params.From ?? '',
              to: params.To ?? '',
              body: params.Body ?? '',
            });
            // Avoid an unmetered, billable TwiML reply. Normal task replies and
            // approval notifications use the budget-reserved delivery path.
            return {
              status: 200,
              text: '<?xml version="1.0" encoding="UTF-8"?><Response/>',
              contentType: 'text/xml',
            };
          },
        },
      ],
    };

    if (!client.configured()) {
      console.warn('sms module enabled but unavailable — set TWILIO_* in .env');
      return { exports: client, hooks };
    }
    registerSmsTools(registry, {
      sender: client,
      ownerPhone: config.OWNER_PHONE,
      prepareOutbound: async (text) => {
        const voice = await loadVoiceContext(db, router, 'sms', text);
        const result = await rewriteInVoice(router, {
          draft: text,
          register: 'sms',
          context: voice,
        });
        return { text: result.text, flagged: result.flagged };
      },
    });
    return { exports: client, hooks };
  },
});
