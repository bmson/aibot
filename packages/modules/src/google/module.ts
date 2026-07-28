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
import { defineModule, type ModuleHooks, type ModuleServices } from '../platform.js';
import {
  applicationConfirmationTaskHandlers,
  reapExpiredApplicationWatches,
} from './application-confirmations.js';
import { deliverEmailFinal } from './email-channel.js';
import {
  type EmailSyncDeps,
  MailboxSyncCoordinator,
  renewWatch,
  syncMailboxWithDistributedLock,
} from './email-sync.js';
import { gmailSyncEnabled, googleMeta } from './meta.js';

/**
 * A client with no credentials: `configured()` is false and every call is
 * refused. Declared as the module's `absent` value so the
 * composition root can hold a plain field and callers can query it freely.
 */
const unconfiguredGoogleClient = () =>
  new GoogleClient({ clientId: '', clientSecret: '', refreshToken: '' });

export const googleModule = defineModule<GoogleClient>({
  meta: googleMeta,
  absent: unconfiguredGoogleClient,
  create: ({ config, db, registry, router, workspace }) => {
    const client = new GoogleClient({
      clientId: config.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
      refreshToken: config.BOT_GOOGLE_REFRESH_TOKEN,
    });

    const syncDeps = (services: ModuleServices): EmailSyncDeps => ({
      config: services.config,
      db: services.db,
      router: services.router,
      workspace: services.workspace,
      googleClient: client,
      notifyOwner: services.ownerNotifier.notifyOwner,
      observeInboundEmail: async (event) => {
        for (const observe of services.emailObservers) {
          await observe(services, event).catch((err) =>
            console.error('inbound email observer failed', err),
          );
        }
      },
    });
    const confirmDeps = (services: ModuleServices) => ({
      db: services.db,
      notifyOwner: services.ownerNotifier.notifyOwner,
    });

    // Single-flight per runtime instance, not per module file: the coordinator
    // coalesces concurrent Pub/Sub pokes and scheduler ticks, and lives in this
    // closure so tests (and any second create()) get their own.
    let nextSyncDeps: EmailSyncDeps | undefined;
    const coordinator = new MailboxSyncCoordinator(async () => {
      if (!nextSyncDeps) throw new Error('mailbox sync dependencies unavailable');
      return syncMailboxWithDistributedLock(nextSyncDeps);
    });
    const sync = (services: ModuleServices) => {
      nextSyncDeps = syncDeps(services);
      return coordinator.sync();
    };

    // Hooks exist on the unconfigured branch too: routes must answer (the
    // guards inside self-report), and sync no-ops on an unconfigured client —
    // exactly the behavior the agent had when these were hardcoded.
    const hooks: ModuleHooks = {
      webhooks: [
        {
          path: '/gmail/pubsub',
          handler: async (services) => {
            // The push payload is only a poke — history.list is the source of
            // truth. Acknowledge only after the durable history cursor
            // advances; Pub/Sub retries a non-2xx, so a crash loses no poke.
            try {
              await sync(services);
            } catch (error) {
              console.error('pubsub-triggered sync failed', error);
              return { status: 503, json: { error: 'mailbox sync failed' } };
            }
            return { status: 200, json: { ok: true } };
          },
        },
      ],
      internalRoutes: [
        {
          path: '/gmail/watch',
          handler: async (services) => {
            if (!services.config.GMAIL_PUBSUB_TOPIC) {
              return {
                status: 501,
                json: {
                  error:
                    'GMAIL_PUBSUB_TOPIC not set — local dev uses polling; push arrives with deploy',
                },
              };
            }
            const expiration = await renewWatch(
              syncDeps(services),
              services.config.GMAIL_PUBSUB_TOPIC,
            );
            return { status: 200, json: { renewed: true, expiration: expiration.toISOString() } };
          },
        },
        {
          path: '/gmail/sync',
          handler: async (services) => {
            if (!gmailSyncEnabled(services.config)) {
              return {
                status: 200,
                json: { skipped: true, reason: 'gmail sync disabled by module or setting' },
              };
            }
            return { status: 200, json: await sync(services) };
          },
        },
      ],
      // Local fallback cadence (~30s against the 2s tick); prod uses Pub/Sub
      // push plus the every-minute scheduler job above.
      ticks: [
        {
          name: 'email-sync',
          everyTicks: 15,
          run: async (services) => {
            if (!client.configured() || !gmailSyncEnabled(services.config)) return;
            await sync(services);
          },
        },
      ],
      sweepSteps: [
        {
          name: 'reapExpiredApplicationWatches',
          // Preserves the /internal/sweep response key from the hardcoded era.
          reportKey: 'expiredWatches',
          run: (services) => reapExpiredApplicationWatches(confirmDeps(services)),
        },
      ],
      taskHandlers: applicationConfirmationTaskHandlers,
      channel: {
        assertDeliverable: (task) => {
          if (task.type === 'email_triage' && task.trust === 'owner' && !client.configured()) {
            throw new Error('email final delivery is not configured');
          }
        },
        deliverFinal: async (services, task, text) => {
          await deliverEmailFinal({ db: services.db, googleClient: client }, task, text);
        },
        deliverApprovalNotice: async (services, task, text) => {
          await deliverEmailFinal({ db: services.db, googleClient: client }, task, text);
        },
      },
    };

    if (!client.configured()) {
      console.warn('google module enabled but unavailable — run pnpm auth:bot');
      return { exports: client, hooks };
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
    return { exports: client, hooks };
  },
});
