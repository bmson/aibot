/**
 * Deterministic pre-gate for the chat action/conversation triage.
 *
 * The dashboard chat route classifies each turn as an action (→ run through the
 * executor with tools/approvals) or plain conversation (→ stream a tool-less
 * reply). That classification runs on the cheapest `classify` model, which
 * occasionally reads a terse imperative like "add lunch Friday noon" as
 * conversation — sending it to the tool-less path where the model can only
 * role-play the action (the exact silent no-op the triage exists to prevent).
 *
 * The costs are asymmetric: a false "conversation" verdict drops the action
 * entirely, while a false "action" verdict merely costs a slower-but-correct
 * answer via the executor. So we force the action path whenever a message
 * clearly reads as a request to DO or CHECK something, and let the model decide
 * only the genuinely ambiguous rest.
 */

import { detectPersonalReadRequest } from '@assistant/core/workflow/read-intent';

// Leading imperative verbs that are unambiguous actions in an assistant chat.
const LEADING_ACTION =
  /^(add|schedule|book|remind|send|email|e-?mail|text|dm|invite|rsvp|order|buy|purchase|pay|cancel|reschedule|postpone|draft|forward|unsubscribe|subscribe)\b/;

// Object-requiring phrasings whose verbs are too idiom-prone to gate on alone
// ("check this out", "look, ...", "find that funny" must NOT trip these).
const ACTION_PHRASE =
  /(remind me\b|(?:on|to) (?:my|the) calendar|to (?:my|the) (?:to-?do|todo|task|shopping|grocery) list|set (?:a|an|up) (?:reminder|meeting|event|alarm|timer|call|appointment)|(?:book|schedule|set up) (?:a|an|me|us|my)\b|send (?:a|an|the|him|her|them)\b|look up\b|search for\b|check (?:my|the) (?:calendar|inbox|e-?mail|mail|schedule|messages|texts|dms)\b|move (?:my|the) [\w\s]*?(?:meeting|call|appointment|event)|find (?:me |us )?(?:a|an|the)\b)/;

// Surfaces the assistant can actually open with tools.
const READ_TARGET =
  '(?:calendars?|schedule|agenda|inbox|e-?mails?|mail|messages|texts|dms|appointments|events|meetings|reminders|to-?dos?|tasks?)';

// Read phrasings: "look at my calendar", "show me my inbox", "what's on my
// calendar", "go through my email", "tell me my schedule". Verbs are anchored
// to a possessive + target so "check this out" / "look, ..." stay untouched.
// Present-tense only on purpose: "looked at" (a recap) does not match.
const READ_PHRASE = new RegExp(
  [
    String.raw`\b(?:check|look (?:at|in|into|through|over)|go (?:through|over)|review|scan|open|search|pull up|bring up|show(?: me| us)?|see)\s+(?:my|the|our)\s+${READ_TARGET}\b`,
    // "read" is spelled the same in past tense, so "I read the email you
    // drafted" (a recap) must not trip; require a possessive object.
    String.raw`\bread\s+(?:my|our)\s+${READ_TARGET}\b`,
    String.raw`\bwhat(?:'|’)?s (?:on|in) (?:my|the|our) ${READ_TARGET}\b`,
    String.raw`\bwhat (?:do|does) (?:i|we) have (?:on|in|scheduled|coming up|planned)\b`,
    String.raw`\btell me (?:what(?:'|’)?s on |about )?(?:my|the|our) (?:[\w-]+ )?(?:schedule|calendar|agenda|appointments|flights|day|week)\b`,
    String.raw`\b(?:anything|what(?:'|’)?s) (?:new|urgent|important)? ?in (?:my|the) (?:inbox|e-?mail|mail)\b`,
  ].join('|'),
);

// Leading politeness/filler to peel off before looking for an imperative verb.
const LEADING_FILLER =
  /^(hey|hi|hello|yo|ok|okay|so|also|and|then|now|please|pls|kindly|just|quick|quickly|could you|can you|would you|will you|can u|would u|i need (?:you )?to|i'?d like (?:you )?to|i want (?:you )?to|i'?d like|let'?s|lets|go ahead and)\b[\s,:-]*/;

// A failed-action follow-up often has no imperative at all: "I'm not seeing
// the change" means "check/fix the update you just promised." The cheap
// classifier used to treat that as feedback and send it to the no-tools path.
const FAILED_ACTION_FOLLOW_UP =
  /\b(?:i(?:'m| am) not seeing (?:the |any )?(?:change|changes|update|updates)|i (?:do not|don't) see (?:the |any )?(?:change|changes|update|updates)|(?:it|that|this|they|those|these) (?:wasn't|was not|weren't|were not|isn't|is not|aren't|are not|hasn't|has not|haven't|have not) (?:actually )?(?:updated|changed|added|sent|created|saved|scheduled|booked|fixed|applied|submitted)|(?:it|that|this|they|those|these) (?:didn't|did not) (?:actually )?(?:update|change|send|save|work)|nothing (?:changed|happened|was updated|was added|was sent|was created|was saved)|still (?:missing|unchanged|not updated|not changed|not there)|did you (?:actually )?(?:update|change|add|send|create|save|schedule|book|fix|apply|submit))\b/;

const PRIOR_ACTION_COMMITMENT =
  /\b(?:update|change|edit|replace|fix|format|add|send|create|save|schedule|book|apply|submit|upload|share|delete|cancel)(?:d|s|ing)?\b/;

export function looksLikeActionRequest(text: string, priorAssistantText = ''): boolean {
  let t = text.trim().toLowerCase();
  if (!t) return false;
  let prev = '';
  while (t !== prev) {
    prev = t;
    t = t.replace(LEADING_FILLER, '');
  }
  if (
    detectPersonalReadRequest([
      ...(priorAssistantText ? [{ role: 'assistant', content: priorAssistantText }] : []),
      { role: 'user', content: text },
    ])
  ) {
    return true;
  }
  return (
    LEADING_ACTION.test(t) ||
    ACTION_PHRASE.test(t) ||
    READ_PHRASE.test(t) ||
    (FAILED_ACTION_FOLLOW_UP.test(t) &&
      PRIOR_ACTION_COMMITMENT.test(priorAssistantText.toLowerCase()))
  );
}
