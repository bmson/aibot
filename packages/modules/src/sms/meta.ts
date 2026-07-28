import type { ModuleMeta } from '../contract.js';

export const smsMeta = {
  name: 'sms',
  title: 'SMS',
  summary: 'Twilio owner channel, including approval replies from a phone.',
  configKeys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'OWNER_PHONE'],
  readiness: (config) => {
    const ready = Boolean(
      config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_FROM_NUMBER,
    );
    return { ready, detail: ready ? 'ready' : 'missing Twilio settings' };
  },
  billing: {
    external: [
      {
        vendor: 'Twilio',
        required: true,
        // The per-message figure the assistant meters its own spend against
        // is the twilio_sms entry in the rate table seeded by @assistant/db.
        note: 'A phone number rents monthly and messages bill per segment (about $0.0079 each in the US).',
        url: 'https://www.twilio.com/en-us/sms/pricing',
      },
    ],
  },
  // Inbound Twilio webhook; the platform validates X-Twilio-Signature before
  // the module's handler runs.
  webhooks: [{ path: '/twilio/sms', auth: { kind: 'twilioSignature' } }],
} satisfies ModuleMeta;
