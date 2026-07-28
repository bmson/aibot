import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures: string[] = [];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.next' || entry.name === 'node_modules') return [];
      return sourceFiles(absolute);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

/**
 * Client components are the reusable presentation boundary. They may consume
 * serializable props and call server actions, but never import persistence,
 * orchestration, provider adapters, or the server singleton directly.
 */
for (const file of sourceFiles(path.join(repoRoot, 'apps/web'))) {
  const source = readFileSync(file, 'utf8');
  const relative = path.relative(repoRoot, file);
  if (/from ['"]@assistant\/core['"]/.test(source)) {
    failures.push(`${relative} imports the monolithic core barrel; use a documented subpath`);
  }
  if (
    relative !== 'apps/web/lib/server.ts' &&
    (/from ['"]@assistant\/(?:core|db|tools)/.test(source) || /from ['"]drizzle-orm/.test(source))
  ) {
    failures.push(`${relative} bypasses the application-service boundary`);
  }
  if (
    relative === 'apps/web/app/layout.tsx' &&
    (/from ['"]@assistant\/db/.test(source) || /from ['"]drizzle-orm/.test(source))
  ) {
    failures.push(`${relative} bypasses the application-service boundary`);
  }
  // Modules ship provider code behind their root entry point. The web app may
  // read module metadata, which is plain data, but never the runtime.
  if (/from ['"]@assistant\/modules(?!\/meta)/.test(source)) {
    failures.push(`${relative} must import module metadata from @assistant/modules/meta`);
  }
  if (!/^\s*['"]use client['"];/.test(source)) continue;
  const forbidden = [
    /from ['"]@assistant\/(?:config|core|db|modules|tools)/,
    /from ['"]drizzle-orm/,
    /from ['"]@\/lib\/server/,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(source)) {
      failures.push(`${relative} is client UI but imports server/business infrastructure`);
      break;
    }
  }
}

const allowedWorkspaceDependencies: Record<string, readonly string[]> = {
  '@assistant/config': [],
  '@assistant/db': ['@assistant/config'],
  '@assistant/core': ['@assistant/config', '@assistant/db'],
  '@assistant/application': ['@assistant/config', '@assistant/core', '@assistant/db'],
  '@assistant/tools': ['@assistant/core', '@assistant/db'],
  // Modules compose the layers below them; nothing may depend on modules except
  // the agent composition root and metadata consumers.
  '@assistant/modules': [
    '@assistant/config',
    '@assistant/core',
    '@assistant/db',
    '@assistant/tools',
  ],
  // Setup tooling reads configuration and module metadata; it must never reach
  // into the database, provider clients, or the running platform.
  '@assistant/setup': ['@assistant/config', '@assistant/modules'],
};

for (const directory of readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const manifestPath = path.join(repoRoot, 'packages', directory.name, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string;
    dependencies?: Record<string, string>;
  };
  const allowed = allowedWorkspaceDependencies[manifest.name];
  if (!allowed) continue;
  const workspaceDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) =>
    name.startsWith('@assistant/'),
  );
  for (const dependency of workspaceDependencies) {
    if (!allowed.includes(dependency)) {
      failures.push(`${manifest.name} must not depend on ${dependency}`);
    }
  }
}

/**
 * The composition file is agent source even though it sits at the repository
 * root. If the image build stops copying it the bundle fails to resolve it, so
 * this is checked rather than remembered.
 */
const compositionFile = path.join(repoRoot, 'assistant.config.ts');
if (!existsSync(compositionFile)) {
  failures.push('assistant.config.ts is missing; the agent composes its modules from it');
} else {
  const agentDockerfile = readFileSync(
    path.join(repoRoot, 'infra/docker/agent.Dockerfile'),
    'utf8',
  );
  if (!/^COPY\s+assistant\.config\.ts\b/m.test(agentDockerfile)) {
    failures.push('infra/docker/agent.Dockerfile must COPY assistant.config.ts into the build');
  }
}

if (failures.length > 0) {
  console.error('Architecture boundary violations:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Architecture boundaries are clean.');
