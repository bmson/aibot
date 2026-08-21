import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAssistantModules } from '@assistant/config';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = path.join(repoRoot, '.env.example');
const outputPath = path.join(repoRoot, '.env');

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function setValue(source: string, name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} cannot contain a newline`);
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  return pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`;
}

if (existsSync(outputPath)) {
  console.error('.env already exists; setup left it unchanged.');
  console.error('Edit that file directly, then run: pnpm config:check');
  process.exit(1);
}

const requestedModules = argument('modules') ?? 'minimal';
const modules = parseAssistantModules(requestedModules);
const moduleValue = requestedModules.trim().toLowerCase() === 'all' ? 'all' : modules.join(',');
const ownerEmail = argument('owner-email') ?? 'owner@example.com';
const ownerName = argument('owner-name') ?? 'Owner';
const assistantEmail = argument('assistant-email') ?? 'assistant@example.com';
const assistantName = argument('assistant-name') ?? 'Assistant';
const workspaceId = argument('workspace-id') ?? 'assistant';
const timezone = argument('timezone') ?? 'UTC';

let env = readFileSync(examplePath, 'utf8');
for (const [name, value] of Object.entries({
  ASSISTANT_NAME: assistantName,
  ASSISTANT_EMAIL: assistantEmail,
  ASSISTANT_WORKSPACE_ID: workspaceId,
  ASSISTANT_TIMEZONE: timezone,
  ASSISTANT_SIGNATURE: `— ${assistantName}`,
  ASSISTANT_MODULES: moduleValue,
  OWNER_NAME: ownerName,
  OWNER_EMAIL: ownerEmail,
  AUTH_SECRET: randomBytes(32).toString('base64url'),
  MOBILE_API_TOKEN: randomBytes(32).toString('hex'),
  INTERNAL_API_SECRET: randomBytes(32).toString('hex'),
  PROFILE_ENC_KEY: randomBytes(32).toString('hex'),
})) {
  env = setValue(env, name, value);
}
writeFileSync(outputPath, env, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

console.log('Created .env with generated local secrets.');
console.log(`Optional modules: ${moduleValue || 'none (minimal)'}`);
console.log('Next: add OPENROUTER_API_KEY, then run pnpm config:check.');
