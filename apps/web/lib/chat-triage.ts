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

// Leading imperative verbs that are unambiguous actions in an assistant chat.
const LEADING_ACTION =
  /^(add|schedule|book|remind|send|email|e-?mail|text|dm|invite|rsvp|order|buy|purchase|pay|cancel|reschedule|postpone|draft|forward|unsubscribe|subscribe)\b/;

// Object-requiring phrasings whose verbs are too idiom-prone to gate on alone
// ("check this out", "look, ...", "find that funny" must NOT trip these).
const ACTION_PHRASE =
  /(remind me\b|(?:on|to) (?:my|the) calendar|to (?:my|the) (?:to-?do|todo|task|shopping|grocery) list|set (?:a|an|up) (?:reminder|meeting|event|alarm|timer|call|appointment)|(?:book|schedule|set up) (?:a|an|me|us|my)\b|send (?:a|an|the|him|her|them)\b|look up\b|search for\b|check (?:my|the) (?:calendar|inbox|e-?mail|mail|schedule|messages|texts|dms)\b|move (?:my|the) [\w\s]*?(?:meeting|call|appointment|event)|find (?:me |us )?(?:a|an|the)\b)/;

// Leading politeness/filler to peel off before looking for an imperative verb.
const LEADING_FILLER =
  /^(hey|hi|hello|yo|ok|okay|so|also|and|then|now|please|pls|kindly|just|quick|quickly|could you|can you|would you|will you|can u|would u|i need (?:you )?to|i'?d like (?:you )?to|i want (?:you )?to|i'?d like|let'?s|lets|go ahead and)\b[\s,:-]*/;

export function looksLikeActionRequest(text: string): boolean {
  let t = text.trim().toLowerCase();
  if (!t) return false;
  let prev = '';
  while (t !== prev) {
    prev = t;
    t = t.replace(LEADING_FILLER, '');
  }
  return LEADING_ACTION.test(t) || ACTION_PHRASE.test(t);
}
