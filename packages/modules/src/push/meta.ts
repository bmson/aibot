import type { ModuleMeta } from '../contract.js';

export const pushMeta = {
  name: 'push',
  title: 'Push notifications',
  summary: 'Server-side APNs delivery of owner notices and approval pings to the iOS app.',
  configKeys: ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY', 'APNS_BUNDLE_ID'],
  readiness: (config) => {
    const ready = Boolean(
      config.APNS_KEY_ID && config.APNS_TEAM_ID && config.APNS_PRIVATE_KEY && config.APNS_BUNDLE_ID,
    );
    return {
      ready,
      detail: ready
        ? 'ready'
        : 'server APNs credentials are missing; iPhone notification permission is separate',
    };
  },
  billing: {
    external: [
      {
        vendor: 'Apple',
        required: true,
        note: 'APNs delivery is free; signing the provider token requires an Apple Developer Program membership ($99/yr).',
        url: 'https://developer.apple.com/account/resources/authkeys/list',
      },
    ],
  },
} satisfies ModuleMeta;
