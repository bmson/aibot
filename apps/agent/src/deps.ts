import path from 'node:path';
import {
  appendSignature,
  CloudRunDocumentJobLauncher,
  type DocumentProcessorConfig,
  LocalDocumentProcessLauncher,
  loadConfig,
  loadVoiceContext,
  ModelRouter,
  planBrowse,
  repoRoot,
  rewriteInVoice,
} from '@assistant/core';
import { createDb, type Db } from '@assistant/db';
import {
  type BrowserJobLauncher,
  CloudRunCodeJobLauncher,
  CloudRunJobLauncher,
  type CodeJobLauncher,
  GcsWorkspaceStore,
  GoogleClient,
  LocalCodeProcessLauncher,
  LocalProcessLauncher,
  LocalWorkspaceStore,
  registerApplicationTools,
  registerBrowserTools,
  registerBuiltinTools,
  registerCalendarTools,
  registerCodeTools,
  registerDocsTools,
  registerDriveTools,
  registerGmailTools,
  registerReminderTools,
  registerSearchTools,
  registerSheetsTools,
  registerSlidesTools,
  registerSmsTools,
  registerWatchTools,
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
  workspace: LocalWorkspaceStore | GcsWorkspaceStore;
  browserLauncher: BrowserJobLauncher;
  /** Document-processor launcher + callback (Phase 14); undefined = inert (prod pre-deploy). */
  documentProcessor?: DocumentProcessorConfig;
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

  const workspacePrefix = 'workspace/b-bot';
  const workspaceRoot = path.join(repoRoot, '.workspace');
  const workspace =
    config.FILES_DRIVER === 'gcs'
      ? new GcsWorkspaceStore(config.WORKSPACE_BUCKET, workspacePrefix)
      : new LocalWorkspaceStore(workspaceRoot);
  const registry = registerBuiltinTools(new ToolRegistry(), {
    embed: (texts) => router.embed(texts),
    workspace,
  });

  const browserLauncher =
    config.BROWSER_DRIVER === 'cloudrun'
      ? new CloudRunJobLauncher({
          project: config.GCP_PROJECT,
          location: config.GCP_LOCATION,
          jobName: config.BROWSER_JOB_NAME,
          storage: {
            driver: 'gcs',
            bucket: config.WORKSPACE_BUCKET,
            prefix: workspacePrefix,
            ...(config.TRACES_BUCKET
              ? { tracesBucket: config.TRACES_BUCKET, tracesPrefix: 'b-bot' }
              : {}),
          },
        })
      : new LocalProcessLauncher({
          repoRoot,
          workspaceRoot,
          profileEncKey: config.PROFILE_ENC_KEY,
        });
  registerBrowserTools(registry, {
    plan: (input) => planBrowse(router, input),
    launcher: browserLauncher,
    callbackUrl: `${config.PUBLIC_URL}/webhooks/browser/callback`,
  });

  // Phase 13: the code-execution worker — a second credential-free Cloud Run
  // Job occupant, launched the same way (child process locally, Job in prod).
  const codeLauncher: CodeJobLauncher =
    config.CODE_DRIVER === 'cloudrun'
      ? new CloudRunCodeJobLauncher({
          project: config.GCP_PROJECT,
          location: config.GCP_LOCATION,
          jobName: config.CODE_JOB_NAME,
          storage: { driver: 'gcs', bucket: config.WORKSPACE_BUCKET, prefix: workspacePrefix },
        })
      : new LocalCodeProcessLauncher({ repoRoot, workspaceRoot });
  registerCodeTools(registry, {
    launcher: codeLauncher,
    callbackUrl: `${config.PUBLIC_URL}/webhooks/code/callback`,
  });

  // Phase 14: the document-processor worker — a third credential-free occupant
  // that does OCR / office parsing outside the agent container. It stays inert
  // in production until its Cloud Run Job is deployed (PROCESSOR_DRIVER=cloudrun);
  // a prod agent whose driver is still 'local' gets no launcher, so parked
  // documents simply wait rather than spawning an unrunnable child.
  const documentProcessor: DocumentProcessorConfig | undefined =
    config.PROCESSOR_DRIVER === 'cloudrun'
      ? {
          launcher: new CloudRunDocumentJobLauncher({
            project: config.GCP_PROJECT,
            location: config.GCP_LOCATION,
            jobName: config.PROCESSOR_JOB_NAME,
            storage: { driver: 'gcs', bucket: config.WORKSPACE_BUCKET, prefix: workspacePrefix },
          }),
          callbackUrl: `${config.PUBLIC_URL}/webhooks/document/callback`,
        }
      : config.QUEUE_DRIVER === 'local'
        ? {
            launcher: new LocalDocumentProcessLauncher({ repoRoot, workspaceRoot }),
            callbackUrl: `${config.PUBLIC_URL}/webhooks/document/callback`,
          }
        : undefined;
  // Inbox watchers take no outward action and need no provider client, so they
  // are available even when Google/Twilio are not configured.
  registerWatchTools(registry);
  // Recurring reminders write a schedule row and need no provider either.
  registerReminderTools(registry);

  // Web search: registered only when a provider + key are configured (like SMS).
  if (config.SEARCH_PROVIDER !== 'none' && config.SEARCH_API_KEY) {
    registerSearchTools(registry, {
      provider: config.SEARCH_PROVIDER,
      apiKey: config.SEARCH_API_KEY,
    });
  } else {
    console.warn('web.search disabled — set SEARCH_PROVIDER + SEARCH_API_KEY to enable');
  }

  if (googleClient.configured()) {
    const botEmail = 'bot@bmson.com';
    registerGmailTools(registry, {
      client: googleClient,
      botEmail,
      botName: 'AI Bot',
      prepareOutbound: async (text, register) => {
        const context = await loadVoiceContext(db, router, register, text);
        const result = await rewriteInVoice(router, { draft: text, register, context });
        // Sign the outbound email (idempotent); the model's Markdown body is
        // rendered to HTML downstream, so a plain signature line is fine.
        return { text: appendSignature(result.text, context.signature), flagged: result.flagged };
      },
    });
    registerCalendarTools(registry, {
      client: googleClient,
      botEmail,
      ownerEmail: config.OWNER_EMAIL,
    });
    registerDocsTools(registry, {
      client: googleClient,
      botEmail,
      ownerEmail: config.OWNER_EMAIL,
    });
    registerDriveTools(registry, { client: googleClient, workspace, db });
    registerSheetsTools(registry, {
      client: googleClient,
      ownerEmail: config.OWNER_EMAIL,
    });
    registerApplicationTools(registry, { client: googleClient });
    registerSlidesTools(registry, {
      client: googleClient,
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
  cached = {
    config,
    db,
    router,
    registry,
    dispatcher,
    googleClient,
    twilio,
    workspace,
    browserLauncher,
    documentProcessor,
  };
  return cached;
}
