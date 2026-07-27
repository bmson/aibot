import { SkillsPanel, type SkillView } from '@/app/skills/skills-panel';
import { requireOwner } from '@/auth';
import { relativeTime } from '@/lib/format';
import { getApplication } from '@/lib/server';
import { PageHeader, PageShell } from '@/lib/ui';

export const metadata = { title: 'Skills' };

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  await requireOwner();
  const now = new Date();
  const rows = await getApplication().listSkills();

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
    <PageShell size="reading">
      <PageHeader
        title="Skills"
        intro="Procedures the assistant has learned from experience, plus any you add yourself. They're read as advice before the assistant plans — never run automatically — and every action they suggest still follows the normal approval rules."
      />
      <SkillsPanel skills={skills} />
    </PageShell>
  );
}
