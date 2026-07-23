import Link from 'next/link';
import { btn } from '@/lib/ui';

export default function NotFound() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Not found</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        That page doesn’t exist or has moved.
      </p>
      <Link href="/" className={`${btn.primary} mt-5`}>
        Back to home
      </Link>
    </div>
  );
}
