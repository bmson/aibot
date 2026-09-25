import { spawn } from 'node:child_process';

/** Explicit emulator-only entry point: never target a real database or silently skip. */
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
  throw new Error(
    'Start the Firestore emulator and set FIRESTORE_EMULATOR_HOST=127.0.0.1:8789. This command never uses a cloud database.',
  );
}
const response = await fetch(`http://${host}`, { signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error('The Firestore emulator is not ready');
const child = spawn(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    'packages/firestore',
    'packages/persistence',
    'apps/agent/src/firestore-dispatch.test.ts',
    'apps/agent/src/firestore-mcp.test.ts',
    'apps/agent/src/firestore-portable-web-workspace.test.ts',
    'apps/agent/src/firestore-google-calendar.test.ts',
    'apps/agent/src/firestore-schedule.test.ts',
    'apps/agent/src/firestore-approval.test.ts',
    'apps/agent/src/firestore-model-routing.test.ts',
    'apps/agent/src/firestore-runtime-smoke.test.ts',
    'apps/agent/src/firestore-executor.test.ts',
    'apps/agent/src/firestore-document-extraction.test.ts',
    'apps/agent/src/firestore-chat.test.ts',
    'apps/agent/src/firestore-application.test.ts',
    'apps/agent/src/firestore-graph-sync.test.ts',
    'apps/agent/src/firestore-memory-consolidation.test.ts',
    'apps/agent/src/firestore-memory-extraction.test.ts',
    'apps/agent/src/firestore-watches.test.ts',
    'apps/agent/src/firestore-reminders.test.ts',
    'apps/agent/src/firestore-cloudtasks.test.ts',
    'apps/agent/src/firestore-boot-cloudtasks.test.ts',
    'apps/agent/src/firestore-full-composition.test.ts',
    'apps/agent/src/firestore-sweep.test.ts',
    'apps/agent/src/firestore-health-monitor.test.ts',
    'apps/agent/src/firestore-reminder-delivery.test.ts',
    'apps/agent/src/firestore-ambient-refresh.test.ts',
    'apps/agent/src/firestore-open-loop-sweep.test.ts',
    'apps/agent/src/firestore-lookup-tools.test.ts',
    'apps/web/app/costs/page.test.tsx',
    'apps/web/app/packs/actions.firestore.test.ts',
    'apps/web/app/skills/actions.firestore.test.ts',
    'apps/web/app/skills/page.test.tsx',
    'apps/web/app/settings/page.test.tsx',
    'apps/web/lib/task-activity.firestore.test.ts',
    'apps/web/app/profile/page.firestore.test.tsx',
    'apps/web/app/profile/memories/page.test.tsx',
    'apps/web/app/api/mobile/v1/people/route.test.ts',
    'apps/web/lib/chat-server.test.ts',
    'apps/web/app/api/mobile/v1/location/route.firestore.test.ts',
    'apps/web/app/anomalies/actions.firestore.test.ts',
    'apps/web/lib/mobile-improvements-server.test.ts',
    'apps/web/app/tasks/actions.firestore.test.ts',
    'apps/web/app/chat/actions.firestore.test.ts',
    'apps/web/app/api/mobile/v1/devices/route.firestore.test.ts',
    'apps/web/app/profile/actions.firestore.test.ts',
    'apps/web/app/profile/about/page.test.tsx',
    'apps/web/app/api/mobile/v1/memory/library/route.test.ts',
    'apps/web/app/api/mobile/v1/memory/profile/route.firestore.test.ts',
    'apps/web/app/api/mobile/v1/documents/route.firestore.test.ts',
    'apps/web/app/api/mobile/v1/mcp/route.test.ts',
    'apps/web/app/api/mobile/v1/knowledge/route.firestore.test.ts',
    'apps/web/lib/firestore-mobile-workspace.test.ts',
    'scripts/firestore-watch-smoke.test.ts',
    'scripts/consumer-owner-claim.test.ts',
    'scripts/profile-library-parity.test.ts',
    'scripts/profile-people-read.test.ts',
    'scripts/mobile-workspace-memory.test.ts',
    'apps/agent/src/task-runner.test.ts',
    'packages/tools/src/dispatcher.firestore.test.ts',
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, GCLOUD_PROJECT: 'demo-assistant-test' },
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
