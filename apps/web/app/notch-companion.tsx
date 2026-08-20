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
   * One fixed overlay owns the tint, the lower glass, and a crown that holds
   * the island between two side panes of glass.
   *
   * Ordering these by DOM position or z-index has been tried four times and has
   * never been what kept the island clear of the band — the full account is in
   * notch.css. What keeps it clear now is that the band's blur lives on its own
   * layers, `.status-veil-glass` and `.status-crown-glass`, which never overlap
   * the island. The first starts below it while it is open; the latter two sit
   * to its left and right. The grid sizes those side panes from the island's
   * real animated width, so even a long status label remains outside the blur.
   *
   * That is what `data-open` is doing on the overlay as well as on the shape.
   * The glass is a preceding sibling of the island, so it cannot select on the
   * island's own state; the state is lifted to their common parent, and the
   * glass reads it from there.
   *
   * The tint (`.status-veil`) remains a separate, unfiltered layer. Do not give
   * it a backdrop filter.
   *
   * The shape is aria-hidden and the announcement is a sibling of it, never a
   * descendant: toggling aria-hidden on an ancestor of a live region is a good
   * way to have the region silently stop announcing. The live region is always
   * mounted and only its text changes, which is what screen readers expect.
   * That announcement matters — for background work this is the only place some
   * of these steps are ever named.
   */
  return (
    <div className="status-overlay" data-open={open}>
      <span className="status-veil" aria-hidden="true" />
      <span className="status-veil-glass" aria-hidden="true" />
      <div className="status-crown" aria-hidden="true">
        <span className="status-crown-glass" />
        <div className="notch-island" data-open={open} data-tone={shown?.tone ?? 'working'}>
          <div className="notch-island-body">
            <span className="notch-island-glyph">
              <Glyph className="size-3.5" />
            </span>
            <span className="notch-island-label">{shown?.label ?? ''}</span>
          </div>
        </div>
        <span className="status-crown-glass" />
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {shown ? `${shown.label}${shown.tone === 'failed' ? ' — failed' : ''}` : ''}
      </span>
    </div>
  );
}
