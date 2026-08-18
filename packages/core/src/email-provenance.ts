/**
 * Does an inbound email carry content its sender did not write?
 *
 * Email is the one owner-authenticated channel that routinely relays other
 * people's words: a forwarded thread or a quoted reply puts attacker-controlled
 * text inside a DKIM-verified owner message. That is why an email trigger taints
 * the workflow while the same words typed into the web chat do not.
 *
 * The presumption is only worth relaxing when we can positively show the body is
 * entirely the sender's own. This detector answers that question and nothing
 * else — it is not a judgement about whether the content is malicious, and a
 * `false` result is meaningful only for a sender whose identity was actually
 * verified (see `classifySender`: owner trust requires aligned SPF/DKIM/DMARC).
 *
 * It fails closed by construction: every rule adds a reason to treat the message
 * as quoting, none removes one, so an unrecognised quoting style degrades to the
 * existing "taint all email" behaviour rather than silently un-tainting.
 */

/** Subject prefixes that mark the body as a relay of someone else's message. */
const FORWARD_SUBJECT = /^\s*(?:re\s*:\s*)*(?:fwd?|fw)\s*:/i;

const QUOTE_MARKERS: RegExp[] = [
  // Gmail/Apple/Outlook forward separators.
  /^\s*-{2,}\s*forwarded message\s*-{2,}/im,
  /^\s*begin forwarded message\s*:/im,
  /^\s*-{2,}\s*original message\s*-{2,}/im,
  // A quoted block: any line beginning with the ">" citation marker.
  /^\s*>/m,
  // Attribution lines that introduce a quote, e.g.
  // "On Sun, Jul 19, 2026 at 21:52 Owner <owner@example.com> wrote:". The date and name
  // may wrap across lines, so match the bracketing tokens rather than a shape.
  /^\s*on\b[\s\S]{0,300}?\bwrote\s*:/im,
  // Outlook's header block reproduced inline.
  /^\s*from\s*:[^\n]*\n(?:[^\n]*\n){0,4}?\s*(?:sent|date)\s*:/im,
  // A reproduced RFC header pair is a relayed message even without a separator.
  /^\s*from\s*:[^\n]*\n(?:[^\n]*\n){0,4}?\s*subject\s*:/im,
];

/**
 * True when the message appears to quote or forward content from someone other
 * than its sender. Callers must treat `true` — and any message they cannot
 * evaluate — as carrying untrusted content.
 */
export function quotesExternalContent(input: { subject?: string; body?: string }): boolean {
  const subject = input.subject ?? '';
  const body = input.body ?? '';
  if (FORWARD_SUBJECT.test(subject)) return true;
  return QUOTE_MARKERS.some((pattern) => pattern.test(body));
}

/**
 * Did this task come from the owner's forwarded-mail pipe?
 *
 * Such a task runs at OWNER trust — the owner's forwarding rule is what asked
 * for the work — but its `from` address is a THIRD PARTY, not the owner. Every
 * path that treats owner trust as "reply to whoever sent this" must therefore
 * check here first, or it will mail the assistant's output to a stranger.
 *
 * This flag is a readable signal, NOT the safety boundary: it is absent on a
 * corrupted payload, and absent reads as "ordinary mail", which is the
 * permissive direction for a caller using it to suppress a send. The actual
 * boundary is `deliverEmailFinal`'s positive check that the recipient is an
 * owner address, plus the outbound domain allowlist. Keep all three.
 */
export function isForwardedIngest(task: { trigger?: unknown } | null | undefined): boolean {
  const payload = (task?.trigger as { payload?: { ingest?: { forwarded?: unknown } } } | null)
    ?.payload;
  return payload?.ingest?.forwarded === true;
}
