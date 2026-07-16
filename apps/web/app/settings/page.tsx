import { requireOwner } from '@/auth';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await requireOwner();
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
        Configure the assistant — integrations, notification preferences, and guardrails.
      </p>
    </div>
  );
}
