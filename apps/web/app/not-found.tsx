import Link from 'next/link';
import { btn, PageHeader, PageShell } from '@/lib/ui';

export default function NotFound() {
  return (
    <PageShell size="reading" className="pt-10">
      <PageHeader
        title="Not found"
        intro="That page doesn’t exist or has moved."
        actions={
          <Link href="/chat" className={btn.primary}>
            Back to chat
          </Link>
        }
      />
    </PageShell>
  );
}
