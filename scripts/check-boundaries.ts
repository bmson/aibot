import { readdirSync, readFileSync } from 'node:fs';
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
  if (!/^\s*['"]use client['"];/.test(source)) continue;
  const forbidden = [
    /from ['"]@assistant\/(?:config|core|db|tools)/,
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

if (failures.length > 0) {
  console.error('Architecture boundary violations:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Architecture boundaries are clean.');
