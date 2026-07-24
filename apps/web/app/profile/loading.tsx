import { PageShell, Skeleton } from '@/lib/ui';

/** Loading fallback for the Memory overview while its queries resolve. */
export default function Loading() {
  return (
    <PageShell size="reading">
      <Skeleton className="h-9 w-64" />
      <Skeleton className="mt-3 h-4 w-96" />
      <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32 w-full rounded-2xl" />
        ))}
      </div>
      <Skeleton className="mt-4 h-28 w-full rounded-2xl" />
      <div className="mt-6 flex flex-col gap-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-2xl" />
        ))}
      </div>
    </PageShell>
  );
}
