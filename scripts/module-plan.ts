import { appendFileSync } from 'node:fs';
import { parseAssistantModules } from '@assistant/config';

const requested = process.env.ASSISTANT_MODULES?.trim() || 'all';
const enabled = new Set(parseAssistantModules(requested));
const plan = {
  modules: [...enabled],
  browser: enabled.has('browser'),
  code: enabled.has('code'),
  processor: enabled.has('documents'),
};

const githubOutput = process.argv.find((argument) => argument.startsWith('--github-output='));
if (githubOutput) {
  const path = githubOutput.slice('--github-output='.length);
  appendFileSync(
    path,
    [
      `modules=${plan.modules.join(',')}`,
      `browser=${String(plan.browser)}`,
      `code=${String(plan.code)}`,
      `processor=${String(plan.processor)}`,
      '',
    ].join('\n'),
  );
} else {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
