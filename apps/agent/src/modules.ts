import { type Config, isModuleEnabled } from '@assistant/config';
import {
  appendSignature,
  CloudRunDocumentJobLauncher,
  type DocumentProcessorConfig,
  LocalDocumentProcessLauncher,
  loadVoiceContext,
  type ModelRouter,
  planBrowse,
  rewriteInVoice,
} from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  type BrowserJobLauncher,
  CloudRunJobLauncher,
  LocalProcessLauncher,
  registerBrowserTools,
} from '@assistant/tools/browser';
import {
  CloudRunCodeJobLauncher,
  type CodeJobLauncher,
  LocalCodeProcessLauncher,
  registerCodeTools,
} from '@assistant/tools/code';
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
import { registerSmsTools, TwilioClient } from '@assistant/tools/modules/sms';
import type { ToolRegistry } from '@assistant/tools/registry';
import { registerReminderTools } from '@assistant/tools/reminders';
import { registerSearchTools } from '@assistant/tools/search';
import { registerWatchTools } from '@assistant/tools/watches';
import type { WorkspaceStore } from '@assistant/tools/workspace';

interface ModuleContext {
  config: Config;
  db: Db;
  registry: ToolRegistry;
  repoRoot: string;
  router: ModelRouter;
  workspace: WorkspaceStore;
  workspacePrefix: string;
  workspaceRoot: string;
}

export interface InstalledModules {
  googleClient: GoogleClient;
  twilio: TwilioClient;
  browserLauncher?: BrowserJobLauncher;
  documentProcessor?: DocumentProcessorConfig;
}

function installBrowser(context: ModuleContext): BrowserJobLauncher | undefined {
  if (!isModuleEnabled(context.config, 'browser')) return undefined;
  const launcher =
    context.config.BROWSER_DRIVER === 'cloudrun'
      ? new CloudRunJobLauncher({
          project: context.config.GCP_PROJECT,
          location: context.config.GCP_LOCATION,
          jobName: context.config.BROWSER_JOB_NAME,
          storage: {
            driver: 'gcs',
            bucket: context.config.WORKSPACE_BUCKET,
            prefix: context.workspacePrefix,
            ...(context.config.TRACES_BUCKET
              ? {
                  tracesBucket: context.config.TRACES_BUCKET,
                  tracesPrefix: context.config.ASSISTANT_WORKSPACE_ID,
                }
              : {}),
          },
        })
      : new LocalProcessLauncher({
          repoRoot: context.repoRoot,
          workspaceRoot: context.workspaceRoot,
          profileEncKey: context.config.PROFILE_ENC_KEY,
        });
  registerBrowserTools(context.registry, {
    plan: (input) => planBrowse(context.router, input),
    launcher,
    callbackUrl: `${context.config.PUBLIC_URL}/webhooks/browser/callback`,
  });
  return launcher;
}

function installCode(context: ModuleContext): void {
  if (!isModuleEnabled(context.config, 'code')) return;
  const launcher: CodeJobLauncher =
    context.config.CODE_DRIVER === 'cloudrun'
      ? new CloudRunCodeJobLauncher({
          project: context.config.GCP_PROJECT,
          location: context.config.GCP_LOCATION,
          jobName: context.config.CODE_JOB_NAME,
          storage: {
            driver: 'gcs',
            bucket: context.config.WORKSPACE_BUCKET,
            prefix: context.workspacePrefix,
          },
        })
      : new LocalCodeProcessLauncher({
          repoRoot: context.repoRoot,
          workspaceRoot: context.workspaceRoot,
        });
  registerCodeTools(context.registry, {
    launcher,
    callbackUrl: `${context.config.PUBLIC_URL}/webhooks/code/callback`,
  });
}

function installDocumentProcessor(context: ModuleContext): DocumentProcessorConfig | undefined {
  if (!isModuleEnabled(context.config, 'documents')) return undefined;
  if (context.config.PROCESSOR_DRIVER === 'cloudrun') {
    return {
      launcher: new CloudRunDocumentJobLauncher({
        project: context.config.GCP_PROJECT,
        location: context.config.GCP_LOCATION,
        jobName: context.config.PROCESSOR_JOB_NAME,
        storage: {
          driver: 'gcs',
          bucket: context.config.WORKSPACE_BUCKET,
          prefix: context.workspacePrefix,
        },
      }),
      callbackUrl: `${context.config.PUBLIC_URL}/webhooks/document/callback`,
    };
  }
  if (context.config.QUEUE_DRIVER === 'local') {
    return {
      launcher: new LocalDocumentProcessLauncher({
        repoRoot: context.repoRoot,
        workspaceRoot: context.workspaceRoot,
      }),
      callbackUrl: `${context.config.PUBLIC_URL}/webhooks/document/callback`,
    };
  }
  return undefined;
}

function installGoogle(context: ModuleContext): GoogleClient {
  const enabled = isModuleEnabled(context.config, 'google');
  const client = new GoogleClient({
    clientId: enabled ? context.config.GOOGLE_OAUTH_CLIENT_ID : '',
    clientSecret: enabled ? context.config.GOOGLE_OAUTH_CLIENT_SECRET : '',
    refreshToken: enabled ? context.config.BOT_GOOGLE_REFRESH_TOKEN : '',
  });
  if (!enabled) return client;
  if (!client.configured()) {
    console.warn('google module enabled but unavailable — run pnpm auth:bot');
    return client;
  }

  const prepareOutbound = async (text: string, register: 'email_casual' | 'email_professional') => {
    const voice = await loadVoiceContext(context.db, context.router, register, text);
    const result = await rewriteInVoice(context.router, { draft: text, register, context: voice });
    return { text: appendSignature(result.text, voice.signature), flagged: result.flagged };
  };
  registerGmailTools(context.registry, {
    client,
    botEmail: context.config.ASSISTANT_EMAIL,
    botName: context.config.ASSISTANT_NAME,
    workspace: context.workspace,
    prepareOutbound,
  });
  registerCalendarTools(context.registry, {
    client,
    botEmail: context.config.ASSISTANT_EMAIL,
    ownerEmail: context.config.OWNER_EMAIL,
  });
  registerDocsTools(context.registry, {
    client,
    botEmail: context.config.ASSISTANT_EMAIL,
    ownerEmail: context.config.OWNER_EMAIL,
  });
  registerDriveTools(context.registry, { client, workspace: context.workspace, db: context.db });
  registerSheetsTools(context.registry, { client, ownerEmail: context.config.OWNER_EMAIL });
  registerSlidesTools(context.registry, { client, ownerEmail: context.config.OWNER_EMAIL });
  registerApplicationTools(context.registry, { client });
  return client;
}

function installSms(context: ModuleContext): TwilioClient {
  const enabled = isModuleEnabled(context.config, 'sms');
  const client = new TwilioClient(
    enabled ? context.config.TWILIO_ACCOUNT_SID : '',
    enabled ? context.config.TWILIO_AUTH_TOKEN : '',
    enabled ? context.config.TWILIO_FROM_NUMBER : '',
  );
  if (!enabled) return client;
  if (!client.configured()) {
    console.warn('sms module enabled but unavailable — set TWILIO_* in .env');
    return client;
  }
  registerSmsTools(context.registry, {
    sender: client,
    ownerPhone: context.config.OWNER_PHONE,
    prepareOutbound: async (text) => {
      const voice = await loadVoiceContext(context.db, context.router, 'sms', text);
      const result = await rewriteInVoice(context.router, {
        draft: text,
        register: 'sms',
        context: voice,
      });
      return { text: result.text, flagged: result.flagged };
    },
  });
  return client;
}

/**
 * Install only the modules selected in ASSISTANT_MODULES. This is the sole
 * feature-composition point; adding a capability does not require editing the
 * HTTP app, executor, or UI.
 */
export function installAssistantModules(context: ModuleContext): InstalledModules {
  if (isModuleEnabled(context.config, 'watches')) registerWatchTools(context.registry);
  if (isModuleEnabled(context.config, 'reminders')) registerReminderTools(context.registry);
  if (isModuleEnabled(context.config, 'search')) {
    if (context.config.SEARCH_PROVIDER !== 'none' && context.config.SEARCH_API_KEY) {
      registerSearchTools(context.registry, {
        provider: context.config.SEARCH_PROVIDER,
        apiKey: context.config.SEARCH_API_KEY,
      });
    } else {
      console.warn('search module enabled but unavailable — set SEARCH_PROVIDER + SEARCH_API_KEY');
    }
  }

  const browserLauncher = installBrowser(context);
  installCode(context);
  const documentProcessor = installDocumentProcessor(context);
  const googleClient = installGoogle(context);
  const twilio = installSms(context);

  return {
    googleClient,
    twilio,
    ...(browserLauncher ? { browserLauncher } : {}),
    ...(documentProcessor ? { documentProcessor } : {}),
  };
}
