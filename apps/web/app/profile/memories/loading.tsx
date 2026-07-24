import { PageShell, Skeleton } from '@/lib/ui';

/** Loading fallback for the memory library while its page of rows resolves. */
export default function Loading() {
  return (
    <PageShell size="reading">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-5 h-9 w-72" />
      <Skeleton className="mt-3 h-4 w-96" />
      <Skeleton className="mt-6 h-10 w-full rounded-xl" />
      <div className="mt-6 flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-2xl" />
        ))}
      </div>
    </PageShell>
  );
}
