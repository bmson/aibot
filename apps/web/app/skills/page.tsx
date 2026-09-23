import { listMobileWorkspaceSkills } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import { createInstallationStore } from '@assistant/firestore';
import { FirestoreSkillLibraryRepository } from '@assistant/firestore/skill-library';
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
  const config = loadConfig();
  let skills: SkillView[];
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const store = createInstallationStore({
      projectId: config.GCP_PROJECT,
      installationId: config.ASSISTANT_WORKSPACE_ID,
    });
    try {
      const rows = await listMobileWorkspaceSkills(
        new FirestoreSkillLibraryRepository(store),
        config.FIRESTORE_AGENT_ID,
      );
      skills = rows.map((skill) => ({
        ...skill,
        createdLabel: `Updated ${relativeTime(new Date(skill.updatedAt), now)}`,
      }));
    } finally {
      await store.db.terminate();
    }
  } else {
    const rows = await getApplication().listSkills();
    skills = rows.map((s) => ({
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
      createdLabel: `Added ${relativeTime(s.createdAt, now)}`,
    }));
  }

  return (
    <PageShell size="reading">
      <PageHeader
        back={{ href: '/chat', label: 'Chat' }}
        title="Skills"
        intro={
          config.PERSISTENCE_DRIVER === 'firestore'
            ? "Procedures the assistant has learned from experience. They're read as advice before the assistant plans — never run automatically — and every action they suggest still follows the normal approval rules."
            : "Procedures the assistant has learned from experience, plus any you add yourself. They're read as advice before the assistant plans — never run automatically — and every action they suggest still follows the normal approval rules."
        }
      />
      <SkillsPanel skills={skills} readOnly={config.PERSISTENCE_DRIVER === 'firestore'} />
    </PageShell>
  );
}
