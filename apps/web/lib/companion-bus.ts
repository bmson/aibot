/*
 * What the assistant is doing right now, shared between whatever is driving it
 * (the chat client, the shell's server-rendered presence) and the island at the
 * top of the screen that reports it.
 *
 * A module-level store rather than a window CustomEvent: both sides are in the
 * same client bundle, so they share this module instance, and keeping the DOM
 * out of it means the store is SSR-safe and unit-testable without a browser.
 * Subscribers get the current value on subscribe, so an island that mounts
 * after the chat has already published a thought is never left stale.
 */

/** What this tab's conversation has it doing — sets the island's baseline. */
export type CompanionActivity =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'working'
  | 'attention';

/**
 * The shell's app-wide baseline, straight from the server (AssistantPresence):
 * work running anywhere, or something waiting on the owner. Kept separate from
 * `activity` so the chat's live, transient states and the background baseline
 * never overwrite each other — the island takes whichever is more demanding.
 */
export type CompanionPresence = 'idle' | 'working' | 'attention';

/**
 * How a thought is going. The island reads this for its glyph and colour, so
 * the difference between "still working" and "that failed" is visible without
 * reading the label.
 */
export type ThoughtTone = 'thinking' | 'working' | 'waiting' | 'done' | 'failed';

/**
 * One line of the assistant's inner monologue: what it is doing, right now, in
 * the same words the work trail uses ("Searching email"). Null when it is not
 * doing anything — which is what closes the island.
 */
export interface CompanionThought {
  label: string;
  tone: ThoughtTone;
}

export interface CompanionState {
  /** What this tab's conversation has it doing. */
  activity: CompanionActivity;
  /** What the rest of the system has it doing. */
  presence: CompanionPresence;
  /** The step it is on, or null when there is nothing to report. */
  thought: CompanionThought | null;
}

export const INITIAL_COMPANION_STATE: CompanionState = {
  activity: 'idle',
  presence: 'idle',
  thought: null,
};

type Listener = (state: CompanionState) => void;

let current: CompanionState = INITIAL_COMPANION_STATE;
const listeners = new Set<Listener>();

export function getCompanionState(): CompanionState {
  return current;
}

/** Thoughts are compared by value: a re-render that rebuilds the same one is not news. */
function sameThought(a: CompanionThought | null, b: CompanionThought | null): boolean {
  if (a === null || b === null) return a === b;
  return a.label === b.label && a.tone === b.tone;
}

/**
 * Publish a partial change. A patch that changes nothing is dropped without
 * notifying, so a re-render that recomputes the same state cannot restart the
 * island's animation.
 */
export function setCompanionState(patch: Partial<CompanionState>): CompanionState {
  const next: CompanionState = { ...current, ...patch };
  if (
    next.activity === current.activity &&
    next.presence === current.presence &&
    sameThought(next.thought, current.thought)
  ) {
    return current;
  }
  current = next;
  for (const listener of listeners) listener(current);
  return current;
}

export function subscribeCompanion(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop every subscriber and return to the resting state. */
export function resetCompanionState(): void {
  current = INITIAL_COMPANION_STATE;
  listeners.clear();
}
