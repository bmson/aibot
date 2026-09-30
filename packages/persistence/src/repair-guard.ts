/** Shared by runtime triage and the trusted CI patch gate. Keep this module dependency-free. */
export function repairPathBlocked(path: string, allowExecutor = false): boolean {
  if (
    !path ||
    path.startsWith('/') ||
    path.startsWith('~') ||
    path.includes('..') ||
    path.includes('\\') ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return true;
  if (!/^(?:apps|packages)\/[a-zA-Z0-9_./@()[\] -]+$/.test(path)) return true;
  if (/^packages\/core\/src\/workflow\/executor\//.test(path)) {
    return (
      !allowExecutor ||
      !/^packages\/core\/src\/workflow\/executor\/(?:step-loop|finalize|context-helpers|util|seed)(?:\.test)?\.ts$/.test(
        path,
      )
    );
  }
  const protectedFiles = [
    'packages/tools/src/dispatcher.ts',
    'packages/tools/src/registry.ts',
    'packages/tools/src/policies.ts',
    'packages/core/src/workflow/approvals.ts',
    'packages/core/src/workflow/anomaly.ts',
    'packages/core/src/events.ts',
    'packages/core/src/workflow/executor.ts',
    'packages/core/src/workflow/self-maintenance.ts',
    'packages/core/src/workflow/improve.ts',
    'packages/core/src/workflow/dream.ts',
  ];
  return (
    protectedFiles.includes(path) ||
    /(^|\/)(?:auth(?:[./-]|$)|credential|secret|taint|oidc)|credential|secret|approval|trust|policy|policies|permission|privacy|email-provenance|webhooks?\.|(^|\/)\.env|(^|\/)(?:self-repair|repair(?:s)?(?:[./-]|$))|(^|\/)(?:AGENTS\.md|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*|biome[^/]*|vitest[^/]*|Dockerfile|\.git[^/]*)(?:$|\/)|^packages\/(?:config|persistence|db)\//i.test(
      path,
    )
  );
}
