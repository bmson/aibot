import { getAgent, listSkills } from '@assistant/core';
import { SkillsPanel, type SkillView } from '@/app/skills/skills-panel';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getDb } from '@/lib/server';
import { PageHeader } from '@/lib/ui';

export const metadata = { title: 'Skills' };

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const agent = await getAgent(db);
  const rows = await listSkills(db, agent.id);

  const skills: SkillView[] = rows.map((s) => ({
    id: s.id,
    name: s.name,
    preconditions: s.preconditions,
    steps: s.steps,
    gotchas: s.gotchas,
    ownerAuthored: s.ownerAuthored,
    deprecated: s.deprecated,
    useCount: s.useCount,
    successCount: s.successCount,
    failureCount: s.failureCount,
    createdLabel: relativeTime(s.createdAt, now),
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Skills"
        intro="Procedures the assistant has learned from experience, plus any you add yourself. They're read as advice before the assistant plans — never run automatically — and every action they suggest still follows the normal approval rules."
      />
      <SkillsPanel skills={skills} />
    </div>
  );
}
