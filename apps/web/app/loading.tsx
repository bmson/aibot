import { PageShell, Skeleton } from '@/lib/ui';

/** Route-level loading fallback — a light skeleton while the RSC query resolves. */
export default function Loading() {
  return (
    <PageShell size="reading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-3 h-4 w-80" />
      <div className="mt-8 flex flex-col gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    </PageShell>
  );
}
