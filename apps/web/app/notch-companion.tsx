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
/** Keep the persistent shell in sync without turning it into a busy poller. */
const PRESENCE_POLL_MS = 10_000;

const TONE_GLYPH: Record<ThoughtTone, typeof Loader2> = {
  thinking: Sparkles,
  working: Loader2,
  waiting: Hand,
  done: Check,
  failed: TriangleAlert,
};

export function NotchCompanion({ presence }: { presence: Presence }) {
  const [shellPresence, setShellPresence] = useState<Presence>(presence);

  // A root layout is preserved across client navigation. Keep its initial
  // server snapshot, but refresh this tiny projection so an approval that
  // resumes and then settles cannot leave "Needs you" stranded on screen.
  useEffect(() => {
    setShellPresence(presence);
  }, [presence]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/api/shell/status', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as { presence?: unknown };
        if (
          !cancelled &&
          (payload.presence === 'idle' ||
            payload.presence === 'working' ||
            payload.presence === 'attention')
        ) {
          setShellPresence(payload.presence);
        }
      } catch {
        // Keep the last known state while offline; the next interval retries.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), PRESENCE_POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // Publish the server's baseline. Its own effect so a navigation that changes
  // the shell's presence updates the island without remounting it.
  useEffect(() => {
    setCompanionState({ presence: shellPresence });
  }, [shellPresence]);

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
      const current = shownRef.current;
      // Dependency identity should already be stable, but this component sits
      // at the root of every page and must be defensive. A value guard keeps a
      // rebuilt-but-equivalent thought from ever turning this effect into a
      // setState/render loop (React production error #185).
      if (current?.label === live.label && current.tone === live.tone) return;
      shownRef.current = live;
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
   * One fixed overlay owns the closed-state tint and low blur plus the island
   * itself. There is deliberately no visual surface beside, beneath, or behind
   * the black shape while it is open. Physical iOS Web Apps can flatten even an
   * unfiltered translucent sibling across the Island before z-order is
   * resolved; Simulator does not reproduce that compositor path reliably.
   * Both veil nodes therefore leave the tree for the entire open state.
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
      {/* Absence from the tree is the reliable physical-device boundary. Even
          the unfiltered tint is removed because real iPhones and Simulator do
          not flatten translucent fixed siblings in exactly the same way. */}
      {open ? null : (
        <>
          <span className="status-veil" aria-hidden="true" />
          <span className="status-veil-glass" aria-hidden="true" />
        </>
      )}
      <div className="status-crown" aria-hidden="true">
        <div className="notch-island" data-open={open} data-tone={shown?.tone ?? 'working'}>
          <div className="notch-island-body">
            <span className="notch-island-glyph">
              <Glyph className="size-3.5" />
            </span>
            <span className="notch-island-label">{shown?.label ?? ''}</span>
          </div>
        </div>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {shown ? `${shown.label}${shown.tone === 'failed' ? ' — failed' : ''}` : ''}
      </span>
    </div>
  );
}
