import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@assistant/db', '@assistant/core', '@assistant/tools'],
  // unauthorized() in auth.ts renders app/unauthorized.tsx with a real 401 status.
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
