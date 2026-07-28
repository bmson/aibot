import { loadConfig } from '@assistant/config';
import { moduleDiagnostics, validateAssistantConfig } from '@assistant/modules/meta';

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  console.error('Configuration is invalid.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`Assistant: ${config.ASSISTANT_NAME} <${config.ASSISTANT_EMAIL}>`);
console.log(`Workspace: workspace/${config.ASSISTANT_WORKSPACE_ID}`);
console.log(`Runtime: ${config.QUEUE_DRIVER === 'cloudtasks' ? 'Google Cloud' : 'local'}`);
console.log('Modules:');
for (const diagnostic of moduleDiagnostics(config)) {
  const marker = !diagnostic.enabled ? '○' : diagnostic.ready ? '✓' : '!';
  console.log(`  ${marker} ${diagnostic.module}: ${diagnostic.detail}`);
}

const problems = validateAssistantConfig(config);
if (problems.length > 0) {
  console.error('Production configuration problems:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else if (!config.OPENROUTER_API_KEY) {
  console.warn('OPENROUTER_API_KEY is empty; the app can boot locally but model calls will fail.');
} else {
  console.log('Configuration is ready.');
}
