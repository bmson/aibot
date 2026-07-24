import { PageShell, Skeleton } from '@/lib/ui';

/** Loading fallback for a person's profile while their facts resolve. */
export default function Loading() {
  return (
    <PageShell size="reading">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="mt-5 h-9 w-72" />
      <Skeleton className="mt-3 h-4 w-full max-w-xl" />
      <Skeleton className="mt-6 h-40 w-full rounded-2xl" />
      <Skeleton className="mt-8 h-6 w-40" />
      <div className="mt-3 flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-2xl" />
        ))}
      </div>
    </PageShell>
  );
}
