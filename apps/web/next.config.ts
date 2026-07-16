import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@assistant/db', '@assistant/core', '@assistant/tools'],
  // unauthorized() in auth.ts renders app/unauthorized.tsx with a real 401 status.
  experimental: { authInterrupts: true },
  // Workspace packages are NodeNext TS sources with `.js` specifiers — map them back to .ts.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;
