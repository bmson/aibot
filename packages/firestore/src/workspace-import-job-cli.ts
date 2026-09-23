import { runWorkspaceImportJob } from './workspace-import-job.js';

runWorkspaceImportJob(process.env)
  .then((summary) => console.log(JSON.stringify(summary)))
  .catch(() => {
    // Never print source bytes, object contents, credentials, or row-level data.
    console.error('Workspace import job failed; inspect pinned object and target readiness');
    process.exitCode = 1;
  });
