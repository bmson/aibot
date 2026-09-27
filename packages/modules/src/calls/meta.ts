import type { ModuleMeta } from '../contract.js';
import { callsToolLabels } from './labels.js';

export const callsMeta = {
  name: 'calls',
  title: 'Phone calls',
  summary:
    'The assistant places approved phone calls and holds the conversation live, disclosing that it is an AI.',
  configKeys: [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'TWILIO_VOICE_FROM_NUMBER',
    'CALL_ALLOWED_COUNTRY_CODES',
    'CALL_DAILY_LIMIT',
    'CALL_MAX_MINUTES',
    'PUBLIC_URL',
  ],
  readiness: (config) => {
    const from = config.TWILIO_VOICE_FROM_NUMBER || config.TWILIO_FROM_NUMBER;
    const ready = Boolean(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && from);
    return {
      ready,
      detail: ready
        ? 'ready (choose a voice model in Settings → AI providers)'
        : 'missing Twilio settings — run pnpm setup:phone',
    };
  },
  billing: {
    external: [
      {
        vendor: 'Twilio',
        required: true,
        note: 'A number rents monthly; outbound US calls bill per minute (about $0.014).',
        url: 'https://www.twilio.com/en-us/voice/pricing/us',
      },
      {
        vendor: 'OpenAI or Google Vertex AI',
        required: true,
        note: 'The live voice model bills per audio token — roughly $0.05–$0.30 a minute depending on the model.',
      },
    ],
  },
  ui: {
    navHrefs: ['/calls'],
    toolLabels: callsToolLabels,
  },
  webhooks: [
    // Someone calling the assistant's number back.
    { path: '/twilio/voice', auth: { kind: 'twilioSignature' } },
    // Call progress and answering-machine verdicts for placed calls.
    { path: '/twilio/voice-status', auth: { kind: 'twilioSignature' } },
  ],
} satisfies ModuleMeta;
