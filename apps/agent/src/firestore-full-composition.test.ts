import { randomUUID } from 'node:crypto';
import { loadConfig, resetConfigForTest } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createDb = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('createDb must not run in the Firestore composition');
  }),
);
vi.mock('@assistant/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/db')>()),
  createDb,
}));

const { composeFirestoreAgent } = await import('./deps.js');
const { runFirestoreSweep } = await import('./firestore-sweep.js');
const { default: composition } = await import('../../../assistant.config.js');

/**
 * Tools the Firestore composition serves without SQL, and tools that are
 * registered when every production module is enabled but still reach
 * PostgreSQL when executed. Every registered tool must be in one list, so a
 * new tool cannot silently land in the Firestore runtime unclassified. Move a
 * tool across only with an SQL-proxy emulator test. See
 * docs/firestore-agent-runtime-inventory.md.
 */
const PORTABLE_TOOLS = [
  'applications.append_confirmation_doc',
  'applications.apply_confirmation',
  'applications.cancel_confirmation',
  'applications.list_confirmations',
  'applications.watch_confirmation',
  // Job launches stage through execution persistence; their result callbacks
  // (webhooks, not tools) are still SQL — see the inventory.
  'browser.execute',
  'browser.plan',
  'calendar.availability',
  'calendar.cancel_event',
  'calendar.create_event',
  'calendar.list_calendars',
  'calendar.list_events',
  'calendar.respond_to_event',
  'calendar.search_events',
  'calendar.update_event',
  'code.execute',
  'contacts.lookup',
  'conversations.search',
  'docs.append',
  'docs.create',
  'docs.get',
  'docs.replace_text',
  'docs.share',
  'documents.search',
  'drive.download',
  'drive.ingest',
  'drive.read',
  'drive.search',
  'gmail.create_draft',
  'gmail.modify',
  'gmail.read_thread',
  'gmail.search',
  'gmail.send',
  'goals.create',
  'goals.list',
  'goals.update_progress',
  'maps.directions',
  'memory.graph_snapshot',
  'memory.recall',
  'memory.save',
  'mission.update',
  'occasions.list',
  'occasions.save',
  'owner.notify',
  'reminder.cancel',
  'reminder.create',
  'reminder.list',
  'sheets.append_rows',
  'sheets.create',
  'sheets.get_rows',
  'sheets.write_rows',
  'situations.change',
  'situations.decisions',
  'situations.read',
  'situations.sources',
  'slides.append',
  'slides.create',
  'sms.send',
  'sports.scores',
  'task.schedule',
  'tools.read_result',
  'watch.cancel',
  'watch.create',
  'watch.list',
  'watch.web',
  'weather.lookup',
  'web.fetch',
  'web.search',
  'workspace.list',
  'workspace.read',
  'workspace.write',
];
const SQL_DEPENDENT_TOOLS: string[] = [];

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore agent composition with every production module',
  () => {
    const agentId = randomUUID();
    const installationId = `full-composition-${randomUUID()}`;
    const store = createInstallationStore({ projectId: 'demo-assistant-test', installationId });

    beforeEach(async () => {
      vi.stubEnv('METADATA_SERVER_DETECTION', 'none');
      resetConfigForTest();
      await store.doc('agents', agentId).set({ id: agentId, name: 'Owner', timezone: 'UTC' });
      await store.doc('coordination', 'budget-policy').set({
        dailyLimitMicros: 1_000_000,
        monthlyLimitMicros: 10_000_000,
        softPct: 80,
      });
    });

    afterEach(async () => {
      await store.db.recursiveDelete(store.root);
      resetConfigForTest();
      vi.unstubAllEnvs();
    });

    function productionConfig() {
      return loadConfig({
        PERSISTENCE_DRIVER: 'firestore',
        ASSISTANT_MODULES: 'all',
        ASSISTANT_WORKSPACE_ID: installationId,
        FIRESTORE_AGENT_ID: agentId,
        FIRESTORE_EMBEDDING_SPACE:
          '{"provider":"openai","model":"text-embedding-3-small","dimensions":1536,"revision":"1"}',
        GCP_PROJECT: 'demo-assistant-test',
        QUEUE_DRIVER: 'local',
        OPENROUTER_API_KEY: 'test-key',
        // Configured credentials, so every module registers its full tool set.
        GOOGLE_OAUTH_CLIENT_ID: 'client',
        GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
        BOT_GOOGLE_REFRESH_TOKEN: 'refresh',
        TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15550000000',
        OWNER_PHONE: '+15550000001',
        SEARCH_PROVIDER: 'brave',
        SEARCH_API_KEY: 'search-key',
        APNS_KEY_ID: 'KEY1234567',
        APNS_TEAM_ID: 'TEAM123456',
        APNS_PRIVATE_KEY: Buffer.from('not-a-real-key').toString('base64'),
        APNS_BUNDLE_ID: 'test.bundle',
      });
    }

    it('constructs every production module and tool with no SQL client', async () => {
      const errors: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const deps = composeFirestoreAgent(productionConfig());

      expect(createDb).not.toHaveBeenCalled();
      expect([...deps.modules.installed].sort()).toEqual(
        composition.modules.map((module) => module.meta.name).sort(),
      );
      const registered = deps.registry
        .toolsForTask('owner')
        .map((tool) => tool.name)
        .sort();
      expect(registered).toEqual([...PORTABLE_TOOLS, ...SQL_DEPENDENT_TOOLS].sort());

      // Recurring work that still needs SQL is declared, and the Firestore
      // runtime skips it rather than tripping over it every tick.
      expect(deps.modules.ticks.filter((tick) => !tick.portable).map((tick) => tick.name)).toEqual(
        [],
      );
      expect(
        deps.modules.sweepSteps.filter((step) => !step.portable).map((step) => step.name),
      ).toEqual([]);

      // The complete maintenance pass, with every module installed, runs on
      // Firestore alone. Step failures are logged rather than thrown, so the
      // SQL tripwire's message is what would reveal a regression.
      const result = await runFirestoreSweep(deps);
      expect(result.ready).toBe(true);
      expect(errors.filter((line) => line.includes('PostgreSQL access is unavailable'))).toEqual(
        [],
      );
      expect(createDb).not.toHaveBeenCalled();
    });

    it('still refuses to boot the modules that reach SQL at runtime', async () => {
      const { validateAgentPersistenceConfig } = await import('@assistant/config');
      const config = productionConfig();
      expect(
        validateAgentPersistenceConfig(config, {
          ASSISTANT_WORKSPACE_ID: installationId,
        }),
      ).toContain(
        'ASSISTANT_MODULES=google still needs PostgreSQL; Firestore agent mode supports reminders,calendar,browser,code,search,maps,watches,push,sms,documents',
      );
    });
  },
);
