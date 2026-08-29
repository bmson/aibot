import { redirect } from 'next/navigation';

export const metadata = { title: 'Knowledge library' };

/** Legacy deep links now enter the unified knowledge workspace. */
export default async function MemoryLibraryRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const current = await searchParams;
  const next = new URLSearchParams({ view: 'library' });
  for (const [key, value] of Object.entries(current)) {
    if (value) next.set(key, value);
  }
  redirect(`/profile/knowledge?${next.toString()}`);
}
