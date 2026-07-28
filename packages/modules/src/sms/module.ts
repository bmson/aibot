import { loadVoiceContext, rewriteInVoice } from '@assistant/core';
import { registerSmsTools, TwilioClient } from '@assistant/tools/modules/sms';
import { defineModule } from '../platform.js';
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
    if (!client.configured()) {
      console.warn('sms module enabled but unavailable — set TWILIO_* in .env');
      return { exports: client };
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
    return { exports: client };
  },
});
