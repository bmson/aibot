import path from 'node:path';
import {
  loadConfig,
  loadVoiceContext,
  ModelRouter,
  repoRoot,
  rewriteInVoice,
} from '@assistant/core';
import { createDb, type Db } from '@assistant/db';
import {
  GoogleClient,
  registerBuiltinTools,
  registerCalendarTools,
  registerGmailTools,
  registerSmsTools,
  ToolDispatcher,
  ToolRegistry,
  TwilioClient,
} from '@assistant/tools';

export interface AgentDeps {
  config: ReturnType<typeof loadConfig>;
  db: Db;
  router: ModelRouter;
  registry: ToolRegistry;
  dispatcher: ToolDispatcher;
  googleClient: GoogleClient;
  twilio: TwilioClient;
}

let cached: AgentDeps | undefined;

export function buildDeps(): AgentDeps {
  if (cached) return cached;
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const router = new ModelRouter(db, config.OPENROUTER_API_KEY);

  const googleClient = new GoogleClient({
    clientId: config.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: config.BOT_GOOGLE_REFRESH_TOKEN,
  });

  const registry = registerBuiltinTools(new ToolRegistry(), {
    embed: (texts) => router.embed(texts),
    workspaceDir: path.join(repoRoot, '.workspace'),
  });

  if (googleClient.configured()) {
    const botEmail = 'bot@bmson.com';
    registerGmailTools(registry, {
      client: googleClient,
      botEmail,
      prepareOutbound: async (text, register) => {
        const context = await loadVoiceContext(db, router, register, text);
        const result = await rewriteInVoice(router, { draft: text, register, context });
        return { text: result.text, flagged: result.flagged };
      },
    });
    registerCalendarTools(registry, {
      client: googleClient,
      botEmail,
      ownerEmail: config.OWNER_EMAIL,
    });
  } else {
    console.warn('google tools disabled — run pnpm auth:bot to enable Gmail/Calendar');
  }

  const twilio = new TwilioClient(
    config.TWILIO_ACCOUNT_SID,
    config.TWILIO_AUTH_TOKEN,
    config.TWILIO_FROM_NUMBER,
  );
  if (twilio.configured()) {
    registerSmsTools(registry, {
      sender: twilio,
      ownerPhone: config.OWNER_PHONE,
      prepareOutbound: async (text) => {
        const context = await loadVoiceContext(db, router, 'sms', text);
        const result = await rewriteInVoice(router, { draft: text, register: 'sms', context });
        return { text: result.text, flagged: result.flagged };
      },
    });
  } else {
    console.warn('sms tools disabled — set TWILIO_* in .env to enable');
  }

  const dispatcher = new ToolDispatcher(db, registry);
  cached = { config, db, router, registry, dispatcher, googleClient, twilio };
  return cached;
}
