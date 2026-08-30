/**
 * The compact, cross-client reading order for runtime cards in chat.
 *
 * The message's normal text remains the durable audit/model/channel fallback.
 * This envelope only tells presentation clients what deserves the first glance;
 * older clients ignore it and continue to render the text part.
 */
export interface ChatCardPresentationV1 {
  version: 1;
  headline: string;
  summary: string;
  facts?: Array<{ label: string; value: string }>;
  detailLabel?: string;
  diagnostics?: string[];
}

export interface CompactNoticePart {
  type: 'notice';
  notice: string;
  presentation?: ChatCardPresentationV1;
  taskId?: string;
  [key: string]: unknown;
}

const HEADLINE_LIMIT = 60;
const SUMMARY_LIMIT = 160;
const DIAGNOSTIC_LIMIT = 1_200;

function oneLine(value: string): string {
  return value
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(value: string, limit: number): string {
  const text = oneLine(value);
  if (text.length <= limit) return text;
  const candidate = text.slice(0, limit - 1);
  const boundary = candidate.lastIndexOf(' ');
  return `${candidate.slice(0, boundary >= Math.floor(limit * 0.62) ? boundary : undefined).trim()}…`;
}

function after(value: string, marker: string): string {
  const at = value.indexOf(marker);
  return at === -1 ? '' : value.slice(at + marker.length).trim();
}

function firstUsefulSentence(value: string): string {
  const text = oneLine(value)
    .replace(/^[-–—:\s]+/, '')
    .replace(/^Before I proceed, I need to know:\s*/i, '')
    .replace(/^Waiting on you:\s*/i, '')
    .replace(/^Here(?:’|')s what I found in the connected sources:\s*[-–—]?\s*/i, '');
  const sentence = /^(.+?[.!?])(?:\s|$)/u.exec(text)?.[1] ?? text;
  return clip(sentence, SUMMARY_LIMIT);
}

function quotedTask(value: string): string {
  return /[“"]([^”"]{1,100})[”"]/u.exec(value)?.[1]?.trim() ?? '';
}

function diagnostic(value: string, summary: string): string[] | undefined {
  const full = oneLine(value);
  if (!full || full === summary) return undefined;
  return [clip(full, DIAGNOSTIC_LIMIT)];
}

/**
 * Deterministic copy for runtime state. It intentionally does not ask a model
 * to rewrite failures: the same persisted state reads the same on every client.
 */
export function compactNoticePresentation(kind: string, text: string): ChatCardPresentationV1 {
  const full = oneLine(text);
  let headline = 'Assistant update';
  let summary = firstUsefulSentence(full) || 'Open the details for more information.';
  let detailLabel = 'Details';

  if (kind === 'parked') {
    headline = 'Work paused';
    summary = /resumes? automatically/i.test(full)
      ? 'This work will resume automatically when its limit resets.'
      : firstUsefulSentence(full);
    detailLabel = 'Pause details';
  } else if (kind === 'needs-attention') {
    const question = after(full, 'until you answer:') || after(full, 'blocked on owner input:');
    const task = quotedTask(full);
    headline = task ? clip(task, HEADLINE_LIMIT) : 'Your input is needed';
    summary = question
      ? firstUsefulSentence(question)
      : task
        ? 'This task stopped and needs your direction.'
        : firstUsefulSentence(
            after(full, 'It needs you:') || after(full, 'needs attention:') || full,
          );
    detailLabel = 'Technical details';
  } else if (kind === 'response-contract') {
    headline = 'Verified result';
    summary = firstUsefulSentence(full);
    detailLabel = 'Verification details';
  } else if (kind === 'turn-failed') {
    headline = 'Message didn’t go through';
    summary = 'Nothing was changed. You can try the request again.';
    detailLabel = 'Failure details';
  } else if (kind === 'retracted') {
    headline = 'Response retracted';
    summary = 'This response was removed because its claims were not sufficiently supported.';
    detailLabel = 'Retraction details';
  }

  headline = clip(headline, HEADLINE_LIMIT);
  summary = clip(summary, SUMMARY_LIMIT);
  const diagnostics = diagnostic(full, summary);
  return {
    version: 1,
    headline,
    summary,
    detailLabel,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function legacyNoticeKind(text: string): string | undefined {
  const value = text.trim();
  if (
    value.startsWith("This goal's automatic session is blocked until you answer:") ||
    value.startsWith("This goal's automatic session finished without completing") ||
    value.startsWith('A task stopped and needs you') ||
    value.startsWith('A mission is paused and waiting on you') ||
    value.startsWith('blocked on owner input:')
  ) {
    return 'needs-attention';
  }
  if (value.startsWith("I'm pausing here —") && /resumes? automatically/i.test(value)) {
    return 'parked';
  }
  return undefined;
}

/**
 * Enrich a persisted message without rewriting it. It upgrades known legacy
 * runtime prose into a compact notice and fills the presentation envelope on
 * newer marker-only parts. Decision and data cards already speak for themselves.
 */
export function compactChatMessageParts(
  text: string,
  input: unknown[],
  taskId?: string,
): unknown[] {
  const parts = Array.isArray(input) ? input : [];
  if (
    parts.some((part) => {
      const type = record(part)?.type;
      return type === 'approval' || type === 'budget-request' || type === 'data-card';
    })
  ) {
    return parts;
  }

  let found = false;
  const upgraded = parts.map((part) => {
    const value = record(part);
    if (value?.type !== 'notice' || typeof value.notice !== 'string') return part;
    found = true;
    if (record(value.presentation)?.version === 1) return part;
    return {
      ...value,
      type: 'notice',
      notice: value.notice,
      ...(taskId && typeof value.taskId !== 'string' ? { taskId } : {}),
      presentation: compactNoticePresentation(value.notice, text),
    } satisfies CompactNoticePart;
  });
  if (found) return upgraded;

  const legacyKind = legacyNoticeKind(text);
  if (!legacyKind) return parts;
  return [
    ...parts,
    {
      type: 'notice',
      notice: legacyKind,
      ...(taskId ? { taskId } : {}),
      presentation: compactNoticePresentation(legacyKind, text),
    } satisfies CompactNoticePart,
  ];
}
