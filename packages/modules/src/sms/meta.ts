import { defineModuleMeta } from '../kit.js';

export const smsMeta = defineModuleMeta({
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
  infra: { secretKeys: ['TWILIO_AUTH_TOKEN'] },
  billing: {
    external: [
      {
        vendor: 'Twilio',
        required: true,
        note: 'A phone number rents monthly and messages bill per segment (about $0.0079 each in the US).',
        url: 'https://www.twilio.com/en-us/sms/pricing',
      },
    ],
  },
});
