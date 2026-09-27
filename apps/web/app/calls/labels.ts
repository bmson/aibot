import type { BadgeTone } from '@/lib/ui';

export const CALL_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  dialing: { label: 'Dialing', tone: 'amber' },
  ringing: { label: 'Ringing', tone: 'amber' },
  in_progress: { label: 'On the call', tone: 'green' },
  completed: { label: 'Ended', tone: 'neutral' },
  no_answer: { label: 'No answer', tone: 'neutral' },
  busy: { label: 'Busy', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'red' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export const CALL_OUTCOME: Record<string, string> = {
  achieved: 'Done',
  partially_achieved: 'Partly done',
  not_achieved: 'Not done',
  no_answer: 'No answer',
  voicemail: 'Voicemail',
  failed: 'Failed',
};

export function callDuration(seconds: number | null): string | null {
  if (!seconds) return null;
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}
