import type { FaceState, ThemeName } from './chat-cues';

/*
 * The companion's live state, shared between whatever is driving it (the chat
 * client, the shell's server-rendered presence) and the full-viewport presence
 * layer that renders it.
 *
 * A module-level store rather than a window CustomEvent: both sides are in the
 * same client bundle, so they share this module instance, and keeping the DOM
 * out of it means the store is SSR-safe and unit-testable without a browser.
 * Subscribers get the current value on subscribe, so a presence layer that
 * mounts after the chat has already published a cue is never left stale.
 */

/** What the companion is doing — sets its baseline energy, apart from mood. */
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
 * never overwrite each other — the renderer takes whichever is stronger.
 */
export type CompanionPresence = 'idle' | 'working' | 'attention';

export interface CompanionState {
  /** The newest [face:] cue — what the companion is feeling. */
  expression: FaceState;
  /** The newest [theme:] cue — the color it is feeling it in. */
  mood: ThemeName;
  /** What this tab's conversation has it doing right now. */
  activity: CompanionActivity;
  /** What the rest of the system has it doing. */
  presence: CompanionPresence;
}

export const INITIAL_COMPANION_STATE: CompanionState = {
  expression: 'neutral',
  mood: 'default',
  activity: 'idle',
  presence: 'idle',
};

type Listener = (state: CompanionState) => void;

let current: CompanionState = INITIAL_COMPANION_STATE;
const listeners = new Set<Listener>();

export function getCompanionState(): CompanionState {
  return current;
}

/**
 * Publish a partial change. A patch that changes nothing is dropped without
 * notifying, so a re-render that recomputes the same cue cannot restart the
 * presence layer's easing.
 */
export function setCompanionState(patch: Partial<CompanionState>): CompanionState {
  const next: CompanionState = { ...current, ...patch };
  if (
    next.expression === current.expression &&
    next.mood === current.mood &&
    next.activity === current.activity &&
    next.presence === current.presence
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

/*
 * The wake channel: a transient pulse, separate from state. State says what the
 * companion is feeling and doing; a wake says "something just moved — show
 * yourself". The chat pulses it when a message goes out or lands, and the notch
 * peeks for a moment on each pulse even when the state itself did not change
 * (two replies in a row are both worth looking up for).
 */
type WakeListener = (count: number) => void;

let wakeCount = 0;
const wakeListeners = new Set<WakeListener>();

/** A message was sent or arrived — ask the companion to show itself briefly. */
export function wakeCompanion(): number {
  wakeCount += 1;
  for (const listener of wakeListeners) listener(wakeCount);
  return wakeCount;
}

/** Unlike state, a wake is a moment: new subscribers do NOT get a replay. */
export function subscribeCompanionWake(listener: WakeListener): () => void {
  wakeListeners.add(listener);
  return () => {
    wakeListeners.delete(listener);
  };
}

/** Test-only: drop every subscriber and return to the resting state. */
export function resetCompanionState(): void {
  current = INITIAL_COMPANION_STATE;
  listeners.clear();
  wakeCount = 0;
  wakeListeners.clear();
}
