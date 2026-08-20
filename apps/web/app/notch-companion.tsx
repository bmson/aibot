'use client';

import { Check, Hand, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  type CompanionState,
  type CompanionThought,
  getCompanionState,
  type CompanionPresence as Presence,
  presenceThought,
  setCompanionState,
  subscribeCompanion,
  type ThoughtTone,
} from '@/lib/companion-bus';

/*
 * The assistant's live activity, in the Dynamic Island.
 *
 * The island is the phone's own place for "something is happening right now",
 * and that is what this is: a black shape starting at the very top of the
 * screen — flush with the hardware island, the same black, no seam — that grows
 * down out of it to say what the model is doing. Searching email. Thinking.
 * That failed. Then it closes again.
 *
 * It reports rather than emotes. The words are the ones the work trail already
 * uses (toolLabel), so the line in the island and the row in the log are one
 * fact at two sizes, and a glance at the top of the screen answers "is it still
 * going?" without scrolling anywhere.
 *
 * The chat publishes the thought; this decides only how long it stays legible
 * and how the shape moves.
 */

/** How long a finished thought stays up, so the last step can be read. */
const SETTLE_HOLD_MS = 1800;
/** A failure earns longer — it is the one state worth catching. */
const FAILED_HOLD_MS = 4000;

const TONE_GLYPH: Record<ThoughtTone, typeof Loader2> = {
  thinking: Sparkles,
  working: Loader2,
  waiting: Hand,
  done: Check,
  failed: TriangleAlert,
};

export function NotchCompanion({ presence }: { presence: Presence }) {
  // Publish the server's baseline. Its own effect so a navigation that changes
  // the shell's presence updates the island without remounting it.
  useEffect(() => {
    setCompanionState({ presence });
  }, [presence]);

  const [state, setState] = useState<CompanionState>(getCompanionState);
  useEffect(() => subscribeCompanion(setState), []);

  const live = state.thought ?? presenceThought(state.presence);

  /*
   * What the island is showing, which lags `live` on the way down only. A
   * thought that ends is held briefly rather than vanishing on the frame it
   * completes: the last step of a task is the one worth reading, and a shape
   * that snaps shut the instant work finishes never shows it. A new thought
   * replaces a held one immediately.
   */
  const [shown, setShown] = useState<CompanionThought | null>(live);
  const shownRef = useRef<CompanionThought | null>(live);
  shownRef.current = shown;

  useEffect(() => {
    if (live) {
      setShown(live);
      return;
    }
    const held = shownRef.current;
    if (!held) return;
    const timer = window.setTimeout(
      () => setShown(null),
      held.tone === 'failed' ? FAILED_HOLD_MS : SETTLE_HOLD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [live]);

  const open = shown !== null;
  const Glyph = TONE_GLYPH[shown?.tone ?? 'working'];

  /*
   * One fixed overlay owning both layers, with the island LAST.
   *
   * The veil used to be `body::after` at z-35 against the island's z-50, and on
   * iOS the veil painted over the island anyway. Both are children here now, the
   * island is second, and a later sibling paints on top — but that is only the
   * paint order, and paint order was never what was wrong. The veil's blur puts
   * it on a compositing layer, and the island has to be on one too or it is
   * drawn into the veil's backdrop and blurred through it. What keeps it in
   * front is the 3D transform on `.notch-island` (notch.css); do not remove it,
   * and do not let this DOM order suggest the shape is safe without it.
   *
   * The shape is aria-hidden and the announcement is a sibling of it, never a
   * descendant: toggling aria-hidden on an ancestor of a live region is a good
   * way to have the region silently stop announcing. The live region is always
   * mounted and only its text changes, which is what screen readers expect.
   * That announcement matters — for background work this is the only place some
   * of these steps are ever named.
   */
  return (
    <div className="status-overlay">
      <span className="status-veil" aria-hidden="true" />
      <div
        className="notch-island"
        data-open={open}
        data-tone={shown?.tone ?? 'working'}
        aria-hidden="true"
      >
        <div className="notch-island-body">
          <span className="notch-island-glyph">
            <Glyph className="size-3.5" />
          </span>
          <span className="notch-island-label">{shown?.label ?? ''}</span>
        </div>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {shown ? `${shown.label}${shown.tone === 'failed' ? ' — failed' : ''}` : ''}
      </span>
    </div>
  );
}
