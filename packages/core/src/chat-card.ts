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
    headline = full.startsWith('Completed:') ? 'Partially completed' : 'Result not confirmed';
    summary = firstUsefulSentence(full);
    detailLabel = 'Verification details';
  } else if (kind === 'provider-failed') {
    headline = 'Response interrupted';
    summary = 'The model service was unavailable. Try the request again.';
    detailLabel = 'Failure details';
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

/** A model-only context boundary and its echoed notice must never become reply copy. */
export function stripBackgroundNoticeEcho(text: string): string {
  const marker =
    '[Background notice already delivered to the owner — context only, never restate it:]';
  const at = text.indexOf(marker);
  return at < 0 ? text : text.slice(0, at).trimEnd();
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
  if (
    /^(?:The model provider failed after \d+ retries\b|I couldn't complete this after repeated attempts and stopped\.)/.test(
      value,
    )
  )
    return 'provider-failed';
  if (value.startsWith("I'm pausing here —") && /resumes? automatically/i.test(value)) {
    return 'parked';
  }
  return undefined;
}

/**
 * The original pulse mail producer used the scorer's internal rationale as a
 * summary and labelled every actionable message as requiring a reply. Match
 * its exact envelope, not arbitrary email cards, to repair already-saved chat
 * history on read. Storage and proposed actions remain unchanged.
 */
function readablePulseMailParts(parts: unknown[]): unknown[] {
  const legacy = parts.flatMap((part) => {
    const value = record(part);
    const card = record(value?.data);
    if (
      value?.type !== 'data-card' ||
      card?.kind !== 'proactive-alert' ||
      card.category !== 'email' ||
      typeof card.id !== 'string' ||
      !card.id.startsWith('mail-action:') ||
      card.urgencyLabel !== 'Needs a reply' ||
      typeof card.title !== 'string'
    )
      return [];
    const sender = Array.isArray(card.details)
      ? card.details.map(record).find((detail) => detail?.label === 'From')?.value
      : undefined;
    return [{ part, card, sender }];
  });
  if (!legacy.length) return parts;
  return parts.map((part) => {
    const match = legacy.find((entry) => entry.part === part);
    if (match) {
      // This legacy producer's summary is either its scoring rationale or a
      // duplicate "From …" line. Neither adds an owner-facing fact.
      const { summary: _internalReason, ...card } = match.card;
      return {
        ...record(part),
        data: { ...card, urgencyLabel: 'Needs attention', title: clip(String(card.title), 200) },
      };
    }
    const value = record(part);
    if (value?.type !== 'suggestion' || typeof value.summary !== 'string') return part;
    const source = legacy.find(
      ({ card, sender }) =>
        typeof sender === 'string' && value.summary === `Deal with "${card.title}" from ${sender}?`,
    );
    return source
      ? { ...value, summary: `Help with “${clip(String(source.card.title), 200)}”?` }
      : part;
  });
}

/** Labels describe the proposed work; source text never authors a button. */
function suggestionActionLabel(action: string, context?: Record<string, unknown>): string {
  if (/^Create a calendar event on the owner's own calendar with no attendees for: /.test(action))
    return 'Add to calendar';
  if (/^Set a reminder two days before /.test(action)) return 'Set reminder';
  if (/^Read the email identified by this source data: /.test(action)) return 'Review email';
  if (context?.category === 'email') return 'Handle email';
  return 'Start task';
}

/**
 * A pulse posts its context and decision in one message. Keep the original
 * card for older clients, and give newer clients an explicit pairing rather
 * than asking each renderer to guess which nearby alert a decision belongs to.
 */
function contextualSuggestions(parts: unknown[]): unknown[] {
  const decisions = parts
    .map(record)
    .filter(
      (part) =>
        part?.type === 'suggestion' &&
        typeof part.suggestionId === 'string' &&
        !!part.suggestionId.trim(),
    );
  const contexts = parts.flatMap((part) => {
    const value = record(part);
    const card = record(value?.data);
    return value?.type === 'data-card' &&
      card?.kind === 'proactive-alert' &&
      typeof card.id === 'string' &&
      typeof card.title === 'string'
      ? [card]
      : [];
  });
  const context = decisions.length === 1 && contexts.length === 1 ? contexts[0] : undefined;
  let changed = false;
  const result = parts.map((part) => {
    const value = record(part);
    if (
      value?.type !== 'suggestion' ||
      typeof value.suggestionId !== 'string' ||
      !value.suggestionId.trim()
    )
      return part;
    const actionLabel = suggestionActionLabel(String(value.proposedAction ?? ''), context);
    if (value.actionLabel === actionLabel && (!context || value.contextCard === context))
      return part;
    changed = true;
    return { ...value, actionLabel, ...(context ? { contextCard: context } : {}) };
  });
  return changed ? result : parts;
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
  const parts = contextualSuggestions(readablePulseMailParts(Array.isArray(input) ? input : []));
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
    if (record(value.presentation)?.version === 1 && value.notice !== 'response-contract')
      return part;
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
