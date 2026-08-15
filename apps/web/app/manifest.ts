import type { MetadataRoute } from 'next';
import { getAgentIdentity } from '@/lib/server';

// The assistant name is owner-configurable, so keep the install sheet and the
// home-screen label in sync with the same identity used by the application UI.
export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { name } = await getAgentIdentity();

  return {
    id: '/chat',
    name,
    short_name: name.length <= 12 ? name : 'Assistant',
    description: `${name} — your personal AI assistant`,
    start_url: '/chat',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone'],
    background_color: '#f5f7f7',
    theme_color: '#21666e',
    categories: ['productivity', 'utilities'],
    icons: [
      { src: '/icons/assistant-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/assistant-512.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/icons/assistant-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
