import { PageShell, Skeleton } from '@/lib/ui';

/** Loading fallback for the People directory while its queries resolve. */
export default function Loading() {
  return (
    <PageShell size="reading">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="mt-3 h-4 w-96" />
      <Skeleton className="mt-8 h-11 w-full rounded-xl" />
      <div className="mt-6 flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[4.5rem] w-full rounded-xl" />
        ))}
      </div>
    </PageShell>
  );
}
