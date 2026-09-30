'use client';
import { useState } from 'react';
import { btn } from '@/lib/ui';
export function InvestigationBrief({ prompt }: { prompt: string }) {
  const [status, setStatus] = useState('Copy investigation request');
  return (
    <section
      className="grid gap-3 rounded-xl border border-edge p-4"
      aria-label="Investigate with the bot"
    >
      <h2 className="font-semibold">Investigate with the bot</h2>
      <p className="text-sm text-muted">
        Paste this request into the mobile app. The bot can read the underlying records with its
        audit tools and cite the evidence behind its findings.
      </p>
      <textarea
        className="min-h-32 w-full rounded-lg bg-sunken p-3 text-sm"
        aria-label="Investigation request"
        value={prompt}
        readOnly
      />
      <button
        className={btn.outline}
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(prompt);
            setStatus('Copied');
          } catch {
            setStatus('Select and copy the request above');
          }
        }}
      >
        {status}
      </button>
      <p role="status" className="text-xs text-muted">
        {status === 'Copied' ? 'Investigation request copied.' : ''}
      </p>
    </section>
  );
}
