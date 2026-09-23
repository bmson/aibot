import { runWorkspaceExportJob } from './workspace-export-job.js';

runWorkspaceExportJob(process.env)
  .then((summary) => console.log(JSON.stringify(summary)))
  .catch(() => {
    // Database client errors can include connection details. Keep Cloud Logging free of them.
    console.error('Workspace export failed; inspect job configuration and storage permissions');
    process.exitCode = 1;
  });
