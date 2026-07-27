import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// This repo is also checked out as git worktrees, so Next sees several
// lockfiles and guesses which one is the workspace root — landing on the main
// checkout even when the build is running inside a worktree. Point it at this
// app's own monorepo root instead of leaving it to inference.
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: workspaceRoot,
  transpilePackages: [
    '@assistant/application',
    '@assistant/config',
    '@assistant/db',
    '@assistant/core',
    '@assistant/tools',
  ],
  // unauthorized() in auth.ts renders app/unauthorized.tsx with a real 401 status.
  //
  // Deliberately NOT setting experimental.viewTransition: it only takes effect
  // in Next's experimental app-page runtime, which requires React's experimental
  // channel. On React 19.2 stable the flag is accepted but the router never
  // calls document.startViewTransition, so it buys nothing. Route entry stays
  // with the CSS animation in template.tsx.
  experimental: { authInterrupts: true },
  async redirects() {
    return [{ source: '/', destination: '/chat', permanent: false }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
  // Workspace packages are NodeNext TS sources with `.js` specifiers — map them back to .ts.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;
