'use client';

import { chip } from '@/lib/ui';

/**
 * Quick-reply pills under an assistant reply, from its `data-chips` cue part
 * (see lib/chat-cues.ts). A tap sends the label verbatim as the owner's next
 * turn — the labels are written to be sendable word-for-word. Once the
 * conversation moves past the reply the chips stay visible as a record of
 * what was offered, but fade and disable (the same settling the decision
 * cards do), so a stale option can't be sent out of context.
 */
export function ActionChips({
  labels,
  active,
  onSend,
}: {
  labels: string[];
  active: boolean;
  onSend: (label: string) => void;
}) {
  if (labels.length === 0) return null;
  return (
    // Each chip fades itself when disabled (the shared chip style), so the
    // row needs no opacity of its own.
    <div className="flex flex-wrap gap-2">
      {labels.map((label, index) => (
        <button
          key={label}
          type="button"
          disabled={!active}
          onClick={() => onSend(label)}
          style={{ animationDelay: `${index * 50}ms` }}
          className={`chip-quick-reply ${chip.accent} motion-safe:animate-[presence-arrive_320ms_ease-out_both]`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
