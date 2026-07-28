import { appendSignature, loadVoiceContext, rewriteInVoice } from '@assistant/core';
import {
  GoogleClient,
  registerApplicationTools,
  registerCalendarTools,
  registerDocsTools,
  registerDriveTools,
  registerGmailTools,
  registerSheetsTools,
  registerSlidesTools,
} from '@assistant/tools/modules/google';
import { defineModule } from '../runtime-kit.js';
import { googleMeta } from './meta.js';

/**
 * A client with no credentials: `configured()` is false and every call is
 * refused. The composition root uses this when the module is not installed, so
 * callers can query the client unconditionally.
 */
export const unconfiguredGoogleClient = () =>
  new GoogleClient({ clientId: '', clientSecret: '', refreshToken: '' });

export const googleModule = defineModule<GoogleClient>({
  meta: googleMeta,
  create: ({ config, db, registry, router, workspace }) => {
    const client = new GoogleClient({
      clientId: config.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: config.BOT_GOOGLE_REFRESH_TOKEN,
    });
    if (!client.configured()) {
      console.warn('google module enabled but unavailable — run pnpm auth:bot');
      return { exports: client };
    }

    const prepareOutbound = async (
      text: string,
      register: 'email_casual' | 'email_professional',
    ) => {
      const voice = await loadVoiceContext(db, router, register, text);
      const result = await rewriteInVoice(router, { draft: text, register, context: voice });
      return { text: appendSignature(result.text, voice.signature), flagged: result.flagged };
    };

    registerGmailTools(registry, {
      client,
      botEmail: config.ASSISTANT_EMAIL,
      botName: config.ASSISTANT_NAME,
      workspace,
      prepareOutbound,
    });
    registerCalendarTools(registry, {
      client,
      botEmail: config.ASSISTANT_EMAIL,
      ownerEmail: config.OWNER_EMAIL,
    });
    registerDocsTools(registry, {
      client,
      botEmail: config.ASSISTANT_EMAIL,
      ownerEmail: config.OWNER_EMAIL,
    });
    registerDriveTools(registry, { client, workspace, db });
    registerSheetsTools(registry, { client, ownerEmail: config.OWNER_EMAIL });
    registerSlidesTools(registry, { client, ownerEmail: config.OWNER_EMAIL });
    registerApplicationTools(registry, { client });
    return { exports: client };
  },
});
