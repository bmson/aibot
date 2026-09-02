import { redirect } from 'next/navigation';

/** People moved out of Memory into their own section; keep old links working. */
export default async function LegacyPersonRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/people/${id}`);
}
