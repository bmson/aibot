import type { PersonalReadRequest } from './read-intent.js';

/**
 * The model writes prose, but the task/tool ledger is the authority for what
 * happened. This module is deliberately conservative: when a reply describes
 * an external action without matching evidence, replace it with a transparent
 * response instead of publishing a convincing but false status update.
 */

export interface ActionEvidence {
  toolName: string;
  status: string;
  args?: unknown;
  result: unknown;
  error?: string | null;
  /**
   * False when the row comes from an earlier task in the same conversation.
   * Absent means "this task" so existing callers keep the strict behaviour.
   */
  fromCurrentTask?: boolean;
}

type ActionKind =
  | 'workspace'
  | 'spreadsheet'
  | 'presentation'
  | 'outbound'
  | 'application'
  | 'calendar'
  | 'calendar_read'
  | 'inbox_read'
  | 'research'
  | 'background'
  | 'memory'
  | 'approval';

export interface ResponseContractResult {
  text: string;
  blocked: boolean;
  unsupported: ActionKind[];
}

interface ResponseContractOptions {
  urlCorpus?: string;
  /** Deterministically detected from the latest owner turn. */
  readRequest?: PersonalReadRequest | null;
}

const OUTBOUND_OBJECTS = 'email|message|sms|text|call|outreach|reply|follow-?up';
const APPLICATION_OBJECTS =
  'application|applications|job application|application form|career portal|form submission|jobs?|roles?|positions?';
const CALENDAR_OBJECTS = 'calendar|calendar event|event|appointment|meeting|interview';
const CALENDAR_READ_OBJECTS = 'calendars?|schedule|agenda|upcoming events|appointments';
const INBOX_READ_OBJECTS = 'inbox|e-?mails?|mail|messages|threads|texts';
// Read claims are past-tense only, so "check your calendar" (advice) and
// "I'll check" (a promise) don't trip them.
const READ_ACTIONS =
  'checked|reviewed|looked (?:at|through|over|in|into)|went (?:through|over)|searched|scanned|read through|pulled up|examined|inspected';
const RESEARCH_OBJECTS =
  'research|companies|company list|target companies|job boards?|sources?|search results?';
const BACKGROUND_OBJECTS = 'mission|task|watcher|monitoring|tracker';

const FIRST_PERSON_PREFIX = String.raw`\b(?:i|we|the assistant)(?:['’]ve\s+|\s+(?:(?:have|has|had|just|already|successfully|now|am|are|was|were)\s+)*)`;

/**
 * Detect a completed external action while keeping the object connected to
 * its verb. Looking only for "I sent" plus a later "document" caused an
 * email *about* a document to be mistaken for a document creation.
 */
function completedActionClaim(
  text: string,
  objects: string,
  actions: string,
  statuses = actions,
): boolean {
  const object = `(?:${objects})`;
  const action = `(?:${actions})`;
  const status = `(?:${statuses})`;
  const article = String.raw`(?:a|an|the|your|all)?\s*`;

  const actionBeforeObject = new RegExp(
    String.raw`\b${action}\b[^.\n]{0,44}\b${article}${object}\b`,
    'i',
  );
  const firstPersonAction = new RegExp(
    String.raw`${FIRST_PERSON_PREFIX}(?!(?:not|never)\b)${action}\b[^.\n]{0,80}\b${object}\b`,
    'i',
  );
  const objectStatus = new RegExp(
    String.raw`\b${article}${object}\b[^.\n]{0,70}\b(?:has|have|was|were|is|are)\s+(?:been\s+)?${status}\b`,
    'i',
  );
  const terseObjectStatus = new RegExp(String.raw`\b${object}\b\s*(?::|-|—)?\s*${status}\b`, 'i');

  return (
    actionBeforeObject.test(text) ||
    firstPersonAction.test(text) ||
    objectStatus.test(text) ||
    terseObjectStatus.test(text)
  );
}

function firstPersonCompletedAction(text: string, actions: string): boolean {
  return new RegExp(
    String.raw`${FIRST_PERSON_PREFIX}(?!(?:not|never)\b)(?:${actions})\b`,
    'i',
  ).test(text);
}

/**
 * Keep the guard focused on promises of *ongoing* hidden work. A next-step
 * plan such as "I'll research jobs" is not a completed-action claim, so it
 * must not be rewritten into a misleading failure response.
 */
const backgroundPromise =
  /\b(?:i|we)(?:\s+will|['’]ll)\s+(?:continue|keep)\b|\b(?:i|we)[^.\n]{0,80}\b(?:silently|in the background|while you(?:'|’)re away)\b|\b(?:starting|proceeding|running)\s+(?:silently|in the background)\b|\b(?:silently|in the background|real[- ]time tracker|mission launched)\b/i;
const backgroundApplicationPromise =
  /\b(?:i|we)(?:\s+will|['’]ll)\s+(?:continue|keep)\s+(?:applying|submitting|filing|completing)\b|\b(?:continue|keep)\s+(?:applying|submitting|filing)\s+(?:to|for)\b/i;
const progressClaim =
  /\b\d+\s+(?:target\s+)?(?:companies|applications|outreach(?:\s+messages)?|drafts)\s+(?:identified|logged|added|ready|submitted|sent|completed)\b/i;
const statusNarrative =
  /\b(?:tracker|company list|applications?|outreach|drafts?|target companies)\b[^.\n]{0,80}\b(?:active|live|ready|complete|completed|updated|added|logged|researching|submitted|sent)\b/i;
const artifactStatus =
  /\b(?:spreadsheet|sheet|document|doc|deck|slides|file|tracker)\b[^.\n]{0,40}\b(?:ready|live|active|updated|available|shared)\b/i;
const countedTracker =
  /\b(?:tracker|company list|spreadsheet|sheet)\b[^.\n]{0,70}\b(?:now\s+)?(?:has|have)\s+\d+\b/i;
// Passive outbound: the subject is the recipient rather than the message, so
// the object-anchored outbound patterns miss it ("the client has been emailed",
// "they were notified"). Requires the "(has|have|was|were) been <verb>" form so
// it does not fire on ordinary prose.
const passiveOutbound =
  /\b(?:has|have|was|were)\s+been\s+(?:contacted|emailed|texted|messaged|notified|pinged|reached\s+out\s+to)\b/i;
// A completed claim that a fact was written to long-term memory/the owner
// profile. Requires a completion verb near the memory/profile object, so a
// future-tense "I'll keep that in mind" does not trip it.
const memoryClaim =
  /\b(?:saved|stored|recorded|noted|logged|updated|corrected|remembered|memoriz(?:e|ed)|committed|kept|added|confirmed)\b[^.\n]{0,40}\b(?:in|to|into)?\s*(?:your\s+)?(?:memory|profile|the\s+record)\b/i;
// Negative-result narration of a read: "found no flights on your calendar",
// "nothing in your inbox", "your calendar is clear". A model that never ran a
// read tool asserting emptiness is the same fabrication as a fake "I checked".
const emptyCalendarClaim =
  /\b(?:no|none|nothing|zero)\b[^.\n]{0,40}\b(?:on|in)\s+(?:your|the|my|either|any)\b[^.\n]{0,30}\b(?:calendar|schedule|agenda)\b|\byour (?:calendar|schedule) (?:is|looks|appears) (?:clear|empty|free|wide open)\b/i;
const emptyInboxClaim =
  /\b(?:no|none|nothing|zero)\b[^.\n]{0,40}\bin\s+(?:your|the|my)\b[^.\n]{0,30}\b(?:inbox|mailbox|e-?mail)\b|\byour inbox (?:is|looks|appears) (?:clear|empty)\b/i;

/**
 * Approval rows and short codes are created only by the dispatcher. A model
 * can mimic an earlier notice from conversation history without emitting a
 * tool call, leaving the owner looking for an approval that does not exist.
 */
export function isSimulatedApprovalNotice(text: string): boolean {
  return (
    /\bthis needs your approval before i act\b/i.test(text) ||
    /\bapprove or deny it on the approvals page\b/i.test(text) ||
    /\*\*\[A\d+\]\*\*/i.test(text)
  );
}

function successful(evidence: ActionEvidence): boolean {
  if (evidence.status !== 'succeeded') return false;
  if (!evidence.result || typeof evidence.result !== 'object') return true;

  const result = evidence.result as Record<string, unknown>;
  if (result.ok === false) return false;
  if (typeof result.status === 'number' && result.status >= 400) return false;
  if (result.deliveryStatus === 'unknown') return false;
  return true;
}

/** Browser step actions that actually submit a form (vs. read-only navigation). */
const BROWSER_SUBMIT_ACTIONS: ReadonlySet<string> = new Set([
  'click',
  'press',
  'select',
  'type',
  'upload',
]);

const CONFIRMATION_TEXT =
  /\b(?:application[^.\n]{0,100}\b(?:submitted|received|complete|confirmed)|thank\s+you\s+for\s+applying|we(?:'|’)ve\s+received\s+your\s+application)\b/i;

/**
 * A submission receipt only counts when THIS browser run actually interacted
 * with a form AND then read back an explicit confirmation. A read-only
 * goto+extract of a careers/marketing page that merely contains "thank you for
 * applying" is not evidence of a submission — and that extracted page text is
 * attacker-influenceable, so on its own it must never authorise an
 * "I submitted your application" claim.
 */
function browserApplicationConfirmed(evidence: ActionEvidence): boolean {
  if (!successful(evidence) || evidence.toolName !== 'browser.execute') return false;
  if (!evidence.result || typeof evidence.result !== 'object') return false;
  const outputs = (evidence.result as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs)) return false;
  const submitted = outputs.some((output) => {
    if (!output || typeof output !== 'object') return false;
    const action = (output as { action?: unknown }).action;
    return (
      typeof action === 'string' &&
      BROWSER_SUBMIT_ACTIONS.has(action) &&
      (output as { ok?: unknown }).ok !== false
    );
  });
  if (!submitted) return false;
  return outputs.some((output) => {
    if (!output || typeof output !== 'object') return false;
    const text = (output as { text?: unknown }).text;
    return typeof text === 'string' && CONFIRMATION_TEXT.test(text);
  });
}

/**
 * Outward-facing, hard-to-reverse actions must be evidenced by THIS task: a
 * send, submission, or booking from an earlier turn never authorises claiming
 * a fresh one. Artifact, research, and background kinds accept
 * conversation-scoped evidence, because the thing they refer to still exists —
 * truthfully mentioning a doc created two turns ago was being rewritten into
 * "I have not created anything outside this chat".
 */
const CURRENT_TASK_ONLY: ReadonlySet<ActionKind> = new Set([
  'outbound',
  'application',
  'calendar',
  // "I saved that to memory" is a claim about THIS turn — an earlier save
  // doesn't authorise narrating a fresh one.
  'memory',
  // "I checked your calendar/inbox" narrates a fresh read; last turn's read
  // says nothing about what's there now.
  'calendar_read',
  'inbox_read',
]);

function inScope(kind: ActionKind, item: ActionEvidence): boolean {
  return !CURRENT_TASK_ONLY.has(kind) || item.fromCurrentTask !== false;
}

function supports(kind: ActionKind, evidence: ActionEvidence[], currentTaskOnly = false): boolean {
  const usable = evidence.filter(
    (item) =>
      successful(item) &&
      inScope(kind, item) &&
      (!currentTaskOnly || item.fromCurrentTask !== false),
  );
  const names = usable.map((item) => item.toolName);
  switch (kind) {
    case 'workspace':
      return names.some(
        (name) =>
          /^(docs\.(?:create|append|replace_text|share)|workspace\.write)$/.test(name) ||
          name === 'drive.download',
      );
    case 'spreadsheet':
      return names.some((name) => /^sheets\.(?:create|append_rows|write_rows)$/.test(name));
    case 'presentation':
      return names.some((name) => /^slides\.(?:create|append)$/.test(name));
    case 'outbound':
      return names.some((name) => /^(gmail\.send|sms\.send|email\.send)$/.test(name));
    // A browser run is not a submission receipt. Until there is a dedicated
    // application tool with an explicit confirmation result, never claim an
    // application was submitted.
    case 'application':
      return (
        names.some((name) => name === 'application.submit') ||
        usable.some(browserApplicationConfirmed)
      );
    case 'calendar':
      return names.some((name) => /^calendar\.(create|update|cancel|delete)/.test(name));
    // Any tool in the family proves the surface was opened — "I checked your
    // calendar for conflicts and booked it" backed by calendar.create_event
    // must not read as a fabricated check.
    case 'calendar_read':
      return names.some((name) => /^calendar\./.test(name));
    case 'inbox_read':
      return names.some((name) => /^gmail\./.test(name));
    case 'research':
      return names.some((name) => name === 'web.fetch' || name === 'browser.execute');
    case 'background':
      return names.some(
        (name) =>
          name === 'mission.update' ||
          name === 'task.schedule' ||
          name === 'applications.watch_confirmation',
      );
    // memory.save is the only tool that persists a fact. Claiming a fact was
    // saved/remembered/corrected requires it — otherwise the model is narrating
    // a memory write it never made.
    case 'memory':
      return names.some((name) => name === 'memory.save');
    case 'approval':
      // Genuine approval notices are posted by the executor when it parks the
      // task and do not pass through the model-final response contract.
      return false;
  }
}

/**
 * A Google Workspace link is a *reference*, not a claim. Treating every
 * occurrence of the URL as a creation claim meant that linking a doc the
 * assistant really did build in an earlier turn ("you can track updates
 * here: <link>") was rewritten into a flat denial that it had created
 * anything. Require a completed mutation verb alongside the link, and read
 * the artifact kind off the URL path so a Sheets link is not reported as a
 * document action.
 */
const WORKSPACE_MUTATION =
  /\b(?:created|shared|uploaded|saved|updated|published|generated|prepared|exported|added|wrote|written|filled|populated)\b/i;
const ARTIFACT_EDIT =
  'updated|changed|edited|replaced|added|wrote|written|filled|populated|appended|formatted|reformatted';

const GOOGLE_ARTIFACT_URL = {
  workspace: /https:\/\/docs\.google\.com\/document\//i,
  spreadsheet: /https:\/\/docs\.google\.com\/spreadsheets\//i,
  presentation: /https:\/\/docs\.google\.com\/presentation\//i,
} as const;

/**
 * Line-scoped so the verb has to travel with the link. "I updated the
 * itinerary. Here it is: <link>" is a claim; a bare link under a future-tense
 * sentence is not.
 */
function googleArtifactMutationClaim(text: string, url: RegExp): boolean {
  return text.split('\n').some((line) => url.test(line) && WORKSPACE_MUTATION.test(line));
}

/**
 * An existing artifact may truthfully be referenced using evidence from an
 * earlier turn. A claim that it was freshly edited is different: it needs a
 * successful write in this task, otherwise an old docs.create can mask a new
 * no-op update.
 */
function freshArtifactEditClaim(text: string, kind: 'workspace' | 'spreadsheet' | 'presentation') {
  const objects = {
    workspace: 'document|doc|file|drive file',
    spreadsheet: 'spreadsheet|sheet|tracker',
    presentation: 'deck|slides|presentation',
  }[kind];
  return (
    completedActionClaim(text, objects, ARTIFACT_EDIT) ||
    text
      .split('\n')
      .some(
        (line) =>
          GOOGLE_ARTIFACT_URL[kind].test(line) &&
          new RegExp(`\\b(?:${ARTIFACT_EDIT})\\b`, 'i').test(line),
      )
  );
}

function claimedKinds(text: string): ActionKind[] {
  const kinds = new Set<ActionKind>();
  const lower = text.toLowerCase();

  if (
    completedActionClaim(
      text,
      'document|doc|file|drive file',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added|ready|live|active|available',
    ) ||
    googleArtifactMutationClaim(text, GOOGLE_ARTIFACT_URL.workspace) ||
    (/\b(?:document|doc|file)\b/.test(lower) && artifactStatus.test(text))
  ) {
    kinds.add('workspace');
  }
  if (
    completedActionClaim(
      text,
      'spreadsheet|sheet|tracker',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added|ready|live|active|available',
    ) ||
    googleArtifactMutationClaim(text, GOOGLE_ARTIFACT_URL.spreadsheet) ||
    (/\b(?:spreadsheet|sheet)\b/.test(lower) && artifactStatus.test(text)) ||
    countedTracker.test(text)
  ) {
    kinds.add('spreadsheet');
  }
  if (
    completedActionClaim(
      text,
      'deck|slides|presentation',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added',
      'created|shared|uploaded|downloaded|saved|deleted|updated|published|generated|prepared|exported|added|ready|live|active|available',
    ) ||
    googleArtifactMutationClaim(text, GOOGLE_ARTIFACT_URL.presentation) ||
    (/\b(?:deck|slides|presentation)\b/.test(lower) && artifactStatus.test(text))
  ) {
    kinds.add('presentation');
  }
  if (
    completedActionClaim(
      text,
      OUTBOUND_OBJECTS,
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged',
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged|confirmed',
    ) ||
    firstPersonCompletedAction(
      text,
      'sent|delivered|contacted|emailed|texted|messaged|called|replied|forwarded|reached out to|notified|pinged',
    ) ||
    passiveOutbound.test(text)
  ) {
    kinds.add('outbound');
  }
  if (
    completedActionClaim(
      text,
      APPLICATION_OBJECTS,
      'submitted|applied|completed|confirmed|uploaded|saved|filed',
      'submitted|applied|complete|completed|confirmed|uploaded|saved|filed|received|went through|gone through',
    ) ||
    // Object-free application verbs must stay application-specific. "completed"
    // and "confirmed" are ordinary English ("I've completed the review",
    // "confirmed the address") and were rewriting perfectly good replies into
    // failure boilerplate; they still count when anchored to an application
    // object via completedActionClaim above.
    firstPersonCompletedAction(text, 'submitted|applied|uploaded|filed') ||
    backgroundApplicationPromise.test(text)
  ) {
    kinds.add('application');
  }
  if (
    completedActionClaim(
      text,
      CALENDAR_OBJECTS,
      'scheduled|booked|created|updated|cancelled|canceled|confirmed|added|set up|put',
      'scheduled|booked|created|updated|cancelled|canceled|confirmed|added|set up|put|ready|set|on your calendar',
    )
  ) {
    kinds.add('calendar');
  }
  if (
    completedActionClaim(text, CALENDAR_READ_OBJECTS, READ_ACTIONS) ||
    emptyCalendarClaim.test(text)
  ) {
    kinds.add('calendar_read');
  }
  if (completedActionClaim(text, INBOX_READ_OBJECTS, READ_ACTIONS) || emptyInboxClaim.test(text)) {
    kinds.add('inbox_read');
  }
  if (
    completedActionClaim(
      text,
      RESEARCH_OBJECTS,
      'researched|fetched|browsed|searched|found|identified|collected|located|reviewed|analyzed|analysed|listed|logged',
      'researched|fetched|browsed|searched|found|identified|collected|located|reviewed|analyzed|analysed|listed|logged|ready|complete|completed',
    ) ||
    firstPersonCompletedAction(text, 'researched|fetched|browsed|searched') ||
    progressClaim.test(text) ||
    statusNarrative.test(text) ||
    countedTracker.test(text)
  ) {
    kinds.add('research');
  }
  if (
    backgroundPromise.test(text) ||
    completedActionClaim(
      text,
      BACKGROUND_OBJECTS,
      'scheduled|started|launched|queued|paused|resumed|stopped|cancelled|canceled',
      'scheduled|started|launched|queued|active|running|in flight|sleeping|paused|resumed|stopped|cancelled|canceled|monitoring|tracking',
    ) ||
    (/\b(?:mission|tracker)\b/.test(lower) &&
      (progressClaim.test(text) || statusNarrative.test(text) || countedTracker.test(text)))
  ) {
    kinds.add('background');
  }
  if (memoryClaim.test(text)) kinds.add('memory');
  if (isSimulatedApprovalNotice(text)) kinds.add('approval');

  return [...kinds];
}

/** Only this task's failures — an earlier turn's error is not this attempt. */
function failureDetails(evidence: ActionEvidence[]): string[] {
  return evidence
    .filter((item) => item.fromCurrentTask !== false && !successful(item))
    .slice(-2)
    .map(
      (item) => `${item.toolName}: ${item.error || 'the tool did not return a successful result'}`,
    );
}

export function transparentFailureResponse(evidence: ActionEvidence[]): string {
  const failures = failureDetails(evidence);
  const detail = failures.length ? ` What stopped it: ${failures.join('; ')}.` : '';
  // Keep the opening sentence stable — the web chat matches on it to render
  // these as system notices (apps/web/lib/chat-notices.ts), alongside the
  // structured `contractNotice` flag.
  return `I couldn't verify this completed, so I'm not claiming it did.${detail} Nothing was sent or changed outside this chat — say the word and I'll retry, or adjust the request.`;
}

const UNSUPPORTED_LABEL: Record<ActionKind, string> = {
  workspace: 'the requested document or file action',
  spreadsheet: 'the requested spreadsheet or tracker action',
  presentation: 'the requested presentation action',
  outbound: 'the requested outbound message',
  application: 'the application submission',
  calendar: 'the requested calendar action',
  calendar_read: 'the claimed calendar check',
  inbox_read: 'the claimed inbox check',
  research: 'the requested research',
  background: 'the promised background work',
  memory: 'the requested memory update',
  approval: 'the claimed approval request',
};

/** Map a tool name to the action-kind it evidences (mirror of `supports`). */
function toolKind(name: string): ActionKind | undefined {
  if (
    name === 'drive.download' ||
    name === 'workspace.write' ||
    /^docs\.(?:create|append|replace_text|share)$/.test(name)
  ) {
    return 'workspace';
  }
  if (/^sheets\.(?:create|append_rows|write_rows)$/.test(name)) return 'spreadsheet';
  if (/^slides\.(?:create|append)$/.test(name)) return 'presentation';
  if (/^(gmail\.send|sms\.send|email\.send)$/.test(name)) return 'outbound';
  if (name === 'application.submit') return 'application';
  if (/^calendar\.(create|update|cancel|delete)/.test(name)) return 'calendar';
  if (/^calendar\.(?:list_calendars|list_events|search_events|availability)$/.test(name)) {
    return 'calendar_read';
  }
  if (/^gmail\.(?:search|read_thread)$/.test(name)) return 'inbox_read';
  if (name === 'web.fetch' || name === 'browser.execute') return 'research';
  if (name === 'memory.save') return 'memory';
  if (
    name === 'mission.update' ||
    name === 'task.schedule' ||
    name === 'applications.watch_confirmation'
  ) {
    return 'background';
  }
  return undefined;
}

function describeTool(name: string): string | undefined {
  if (name === 'drive.download') return 'the requested Drive file was staged';
  if (/^docs\.(?:create|append|replace_text|share)$/.test(name)) {
    return 'the Google Doc action completed';
  }
  if (name === 'workspace.write') return 'the workspace file was written';
  if (/^sheets\.(?:create|append_rows|write_rows)$/.test(name)) {
    return 'the Google Sheet action completed';
  }
  if (/^slides\.(?:create|append)$/.test(name)) return 'the Google Slides action completed';
  if (name === 'gmail.send') return 'the email was sent';
  if (name === 'sms.send' || name === 'email.send') return 'the message was sent';
  if (/^calendar\.(create|update|cancel|delete)/.test(name)) return 'the calendar action completed';
  if (/^calendar\.(?:list_calendars|list_events|search_events|availability)$/.test(name)) {
    return 'the calendar was actually read';
  }
  if (/^gmail\.(?:search|read_thread)$/.test(name)) return 'the mailbox was actually read';
  if (name === 'web.fetch') return 'the web request completed';
  if (name === 'memory.save') return 'the fact was saved to memory';
  if (name === 'application.submit') return 'the application was submitted';
  if (name === 'applications.watch_confirmation') return 'the confirmation watch was created';
  if (name === 'mission.update' || name === 'task.schedule') {
    return 'the background task was created or updated';
  }
  return undefined;
}

/**
 * Describe what actually happened, without reprinting the whole conversation.
 * Current-task actions genuinely ran this turn, so they're always reportable.
 * A prior-turn artifact (a doc that still exists) is reported with "earlier in
 * this conversation" only when THIS turn actually referred to that kind and the
 * kind may be cited across turns — so a "save this to memory" turn never lists
 * every earlier Drive/Sheet/calendar action, and a prior outbound/calendar
 * (CURRENT_TASK_ONLY) is never passed off as confirmation of a fresh one.
 */
function verifiedActionDescriptions(
  evidence: ActionEvidence[],
  claimedSet: ReadonlySet<ActionKind>,
): string[] {
  const descriptions = new Set<string>();
  const citable = (kind: ActionKind, item: ActionEvidence): boolean =>
    item.fromCurrentTask !== false || (claimedSet.has(kind) && inScope(kind, item));
  for (const item of evidence) {
    if (!successful(item)) continue;
    const when = item.fromCurrentTask === false ? ' earlier in this conversation' : '';
    const kind = toolKind(item.toolName);
    if (kind !== undefined && citable(kind, item)) {
      const described = describeTool(item.toolName);
      if (described) descriptions.add(`${described}${when}`);
    }
    if (citable('application', item) && browserApplicationConfirmed(item)) {
      descriptions.add(`the portal returned an explicit application confirmation${when}`);
    }
  }
  return [...descriptions];
}

function partialFailureResponse(
  evidence: ActionEvidence[],
  unsupported: ActionKind[],
  claimedSet: ReadonlySet<ActionKind>,
): string | undefined {
  const verified = verifiedActionDescriptions(evidence, claimedSet);
  if (verified.length === 0) return undefined;
  const missing = [...new Set(unsupported.map((kind) => UNSUPPORTED_LABEL[kind]))];
  const failures = failureDetails(evidence);
  const failureDetail = failures.length ? ` What stopped it: ${failures.join('; ')}.` : '';
  // Opening kept stable for the web chat's notice matcher (chat-notices.ts).
  return `Here's what I can confirm: ${verified.join('; ')}. I can't yet confirm ${missing.join(' or ')}, so I'm not claiming that part.${failureDetail}`;
}

// Google surfaces the model legitimately constructs from an id it already has
// (a docs.create returned the id; the model rebuilds the shareable URL). These
// are allowed only when the id in the path is itself present in the evidence.
const CONSTRUCTIBLE_GOOGLE_HOSTS = new Set([
  'docs.google.com',
  'drive.google.com',
  'calendar.google.com',
  'mail.google.com',
]);

const BARE_URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;

interface NormalizedUrl {
  normalized: string;
  noQuery: string;
  host: string;
  idSegments: string[];
}

function normalizeUrl(raw: string): NormalizedUrl | null {
  const cleaned = raw.replace(/[.,;:!?'")\]]+$/, '');
  try {
    const u = new URL(cleaned);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    const base = `${u.protocol}//${host}${path}`.toLowerCase();
    return {
      normalized: `${base}${u.search}`.toLowerCase(),
      noQuery: base,
      host,
      // Lowercased to match the lowercased corpus. Google ids are technically
      // case-sensitive, but rewrite-not-block tolerates that tiny leniency.
      idSegments: path
        .split('/')
        .filter((s) => s.length >= 16)
        .map((s) => s.toLowerCase()),
    };
  } catch {
    return null;
  }
}

/**
 * Strip http(s) links from a final answer that never appeared in the task's
 * sources — a fabricated "confirmation here: https://…" the response contract's
 * action rules don't catch (they only inspect Google-artifact mutation claims).
 *
 * Rewrite, not block: an unevidenced markdown link keeps its label text and
 * loses the href; a bare URL is removed; one trailing note explains the strip.
 * This keeps the false-positive cost to a single link rather than a blanked
 * answer. A link is evidenced when the corpus (tool results + trigger + the
 * owner/tool turns) contains it (with or without its query string). Google
 * doc/drive/calendar/mail links the model reconstructs from an id are allowed
 * only when that id is itself in the corpus; a Google Maps link the model
 * composes from an address is always allowed.
 */
export function enforceUrlProvenance(
  text: string,
  corpus: string,
): { text: string; strippedUrls: string[] } {
  const haystack = corpus.toLowerCase();
  const stripped: string[] = [];
  const isEvidenced = (raw: string): boolean => {
    const n = normalizeUrl(raw);
    if (!n) return true; // unparseable — leave it rather than mangle the text
    if (haystack.includes(n.normalized) || haystack.includes(n.noQuery)) return true;
    if (n.host === 'www.google.com' && n.noQuery.includes('/maps')) return true;
    if (CONSTRUCTIBLE_GOOGLE_HOSTS.has(n.host)) {
      // A bare app link (no id) is harmless; an id-bearing link must cite an
      // id the evidence actually produced.
      return n.idSegments.length === 0 || n.idSegments.every((seg) => haystack.includes(seg));
    }
    return false;
  };

  let out = text.replace(MARKDOWN_LINK_RE, (match, label: string, url: string) => {
    if (isEvidenced(url)) return match;
    stripped.push(url);
    return label;
  });
  out = out.replace(BARE_URL_RE, (match) => {
    if (isEvidenced(match)) return match;
    stripped.push(match);
    return '';
  });
  if (stripped.length > 0) {
    out = `${out.replace(/[ \t]{2,}/g, ' ').trimEnd()}\n\n(I removed a link I couldn't trace to this task's sources.)`;
  }
  return { text: out, strippedUrls: stripped };
}

const CALENDAR_EVENT_READS = new Set(['calendar.list_events', 'calendar.search_events']);

function currentSuccessfulEvidence(evidence: ActionEvidence[]): ActionEvidence[] {
  return evidence.filter((item) => item.fromCurrentTask !== false && successful(item));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resultItems(row: ActionEvidence, key: string): Record<string, unknown>[] {
  const items = record(row.result)?.[key];
  return Array.isArray(items)
    ? items.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function queryCovers(row: ActionEvidence, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const query = record(row.args)?.query;
  if (typeof query !== 'string') return false;
  const lower = query.toLowerCase();
  return terms.every((term) => lower.includes(term.toLowerCase()));
}

function matchingCalendarRows(
  request: PersonalReadRequest,
  current: ActionEvidence[],
): ActionEvidence[] {
  return current.filter((row) => {
    if (!CALENDAR_EVENT_READS.has(row.toolName) || !queryCovers(row, request.queryTerms)) {
      return false;
    }
    const calendarIds = record(row.args)?.calendarIds;
    const result = record(row.result);
    return (
      (!Array.isArray(calendarIds) || calendarIds.length === 0) &&
      Array.isArray(result?.events) &&
      Array.isArray(result.calendarsSearched) &&
      typeof result.complete === 'boolean'
    );
  });
}

function matchingGmailSearchRows(
  request: PersonalReadRequest,
  current: ActionEvidence[],
): ActionEvidence[] {
  return current.filter((row) => {
    if (row.toolName !== 'gmail.search' || !queryCovers(row, request.queryTerms)) return false;
    const result = record(row.result);
    return (
      Array.isArray(result?.results) &&
      typeof result.mailboxSearched === 'string' &&
      Boolean(result.mailboxSearched) &&
      typeof result.complete === 'boolean'
    );
  });
}

function matchingGmailThreadRows(
  searches: ActionEvidence[],
  current: ActionEvidence[],
): ActionEvidence[] {
  const threadIds = new Set(
    searches
      .flatMap((row) => resultItems(row, 'results'))
      .map((item) => stringField(item, 'threadId'))
      .filter(Boolean),
  );
  return current.filter((row) => {
    if (row.toolName !== 'gmail.read_thread') return false;
    const threadId = record(row.args)?.threadId;
    return (
      typeof threadId === 'string' &&
      threadIds.has(threadId) &&
      resultItems(row, 'messages').length > 0
    );
  });
}

function requiredReadGaps(
  request: PersonalReadRequest,
  evidence: ActionEvidence[],
): { labels: string[]; unsupported: ActionKind[] } {
  const current = currentSuccessfulEvidence(evidence);
  const calendars = matchingCalendarRows(request, current);
  const gmailSearches = matchingGmailSearchRows(request, current);
  const gmailHits = gmailSearches.flatMap((row) => resultItems(row, 'results'));
  const gmailThreads = matchingGmailThreadRows(gmailSearches, current);
  const labels: string[] = [];
  const unsupported: ActionKind[] = [];

  if (request.kind !== 'email' && calendars.length === 0) {
    labels.push('a successful all-calendar event search using the requested terms/date range');
    unsupported.push('calendar_read');
  }
  if (request.kind !== 'calendar' && gmailSearches.length === 0) {
    labels.push('a successful Gmail search using the requested terms');
    unsupported.push('inbox_read');
  } else if (request.requiresThreadRead && gmailHits.length > 0 && gmailThreads.length === 0) {
    labels.push('a successful read of a matching Gmail thread');
    unsupported.push('inbox_read');
  }
  return { labels, unsupported: [...new Set(unsupported)] };
}

function stringField(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 2_000) : '';
}

function rawStringField(item: Record<string, unknown>, key: string): string {
  const value = item[key];
  return typeof value === 'string' ? value.trim().slice(0, 8_000) : '';
}

function emailExcerpt(text: string, terms: string[]): string {
  const compacted = text.replace(/\s+/g, ' ').trim();
  if (!compacted) return '';
  const sentences = compacted.split(/(?<=[.!?])\s+/);
  const relevant = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    return (
      terms.some((term) => lower.includes(term.toLowerCase())) ||
      /\b(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        sentence,
      )
    );
  });
  return (relevant.length > 0 ? relevant : sentences).slice(0, 3).join(' ').slice(0, 700);
}

/**
 * Calendar/email answers are rendered from the tool ledger instead of model
 * prose. This is intentionally less flexible: a deterministic list of literal
 * fields is preferable to a fluent answer that can add one plausible event.
 */
function verifiedReadResponse(request: PersonalReadRequest, evidence: ActionEvidence[]): string {
  const current = currentSuccessfulEvidence(evidence);
  const lines = ['Here’s what I found in the connected sources:'];

  if (request.kind !== 'email') {
    const calendarRows = matchingCalendarRows(request, current);
    const events = calendarRows.flatMap((row) => resultItems(row, 'events'));
    const calendars = new Set<string>();
    const ranges = new Set<string>();
    const unavailable: string[] = [];
    let complete = calendarRows.length > 0;
    for (const row of calendarRows) {
      const result = record(row.result);
      const args = record(row.args);
      if (result?.complete === false) complete = false;
      const timeMin = typeof args?.timeMin === 'string' ? args.timeMin : '';
      const timeMax = typeof args?.timeMax === 'string' ? args.timeMax : '';
      if (timeMin && timeMax) ranges.add(`${timeMin} to ${timeMax}`);
      const searched = result?.calendarsSearched;
      if (Array.isArray(searched)) {
        for (const value of searched) if (typeof value === 'string') calendars.add(value);
      }
      const missing = result?.unavailable;
      if (Array.isArray(missing)) {
        for (const value of missing) {
          const item = record(value);
          const name = item ? stringField(item, 'calendar') : '';
          if (name) unavailable.push(name);
        }
      }
    }
    for (const range of ranges) lines.push(`- Calendar range searched: ${range}`);
    if (events.length === 0) {
      lines.push(
        calendarRows.length > 0
          ? `- Calendar search returned no matching events${calendars.size > 0 ? ` across ${[...calendars].join(', ')}` : ''}.`
          : '- Calendar: no successful event read.',
      );
    } else {
      for (const event of events.slice(0, 20)) {
        const summary = stringField(event, 'summary') || '(untitled event)';
        const start = stringField(event, 'start');
        const end = stringField(event, 'end');
        const location = stringField(event, 'location');
        const calendar = stringField(event, 'calendar');
        const attendees = event.attendees;
        const attendeeText = Array.isArray(attendees)
          ? attendees.filter((value): value is string => typeof value === 'string').join(', ')
          : '';
        lines.push(
          `- Calendar: ${summary}${start ? ` — ${start}${end ? ` to ${end}` : ''}` : ''}${location ? ` — ${location}` : ''}${attendeeText ? ` — attendees: ${attendeeText}` : ''}${calendar ? ` (${calendar})` : ''}`,
        );
      }
    }
    if (!complete || unavailable.length > 0) {
      lines.push(
        `- Calendar coverage was incomplete${unavailable.length > 0 ? `; unavailable: ${[...new Set(unavailable)].join(', ')}` : ''}.`,
      );
    }
  }

  if (request.kind !== 'calendar') {
    const searches = matchingGmailSearchRows(request, current);
    const results = searches.flatMap((row) => resultItems(row, 'results'));
    const threadRows = matchingGmailThreadRows(searches, current);
    const threadMessages = threadRows.flatMap((row) => resultItems(row, 'messages'));
    const queries = new Set(
      searches.map((row) => stringField(record(row.args) ?? {}, 'query')).filter(Boolean),
    );
    const mailboxes = new Set(
      searches
        .map((row) => stringField(record(row.result) ?? {}, 'mailboxSearched'))
        .filter(Boolean),
    );
    if (queries.size > 0) {
      lines.push(
        `- Gmail ${mailboxes.size > 0 ? `(${[...mailboxes].join(', ')}) ` : ''}searched for: ${[...queries].map((query) => `“${query}”`).join(', ')}`,
      );
    }
    if (results.length === 0) {
      lines.push(
        searches.length > 0
          ? '- Gmail: no matching messages were returned.'
          : '- Gmail: no successful search.',
      );
    } else {
      for (const message of results.slice(0, 10)) {
        const subject = stringField(message, 'subject') || '(no subject)';
        const from = stringField(message, 'from');
        const date = stringField(message, 'date');
        const snippet = stringField(message, 'snippet');
        lines.push(
          `- Gmail: “${subject}”${from ? ` — from ${from}` : ''}${date ? ` — ${date}` : ''}${snippet ? ` — ${snippet}` : ''}`,
        );
      }
    }
    for (const message of threadMessages.slice(0, 10)) {
      const subject = stringField(message, 'subject') || '(no subject)';
      const from = stringField(message, 'from');
      const date = stringField(message, 'date');
      const excerpt = emailExcerpt(rawStringField(message, 'text'), request.queryTerms);
      lines.push(
        `- Gmail thread: “${subject}”${from ? ` — from ${from}` : ''}${date ? ` — ${date}` : ''}${excerpt ? ` — ${excerpt}` : ''}`,
      );
    }
    if (searches.some((row) => record(row.result)?.complete === false)) {
      lines.push('- Gmail returned more matches than this lookup inspected; coverage was partial.');
    }
  }
  return lines.join('\n');
}

function missingReadResponse(labels: string[], evidence: ActionEvidence[]): string {
  const failures = failureDetails(evidence);
  return [
    `I couldn't verify this from the required sources, so I’m not going to guess. Missing: ${labels.join('; ')}.`,
    failures.length > 0 ? `What stopped the lookup: ${failures.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function enforcePersonalReadGrounding(
  evidence: ActionEvidence[],
  opts?: ResponseContractOptions,
): ResponseContractResult | undefined {
  const request = opts?.readRequest;
  if (!request) return undefined;

  const gaps = requiredReadGaps(request, evidence);
  if (gaps.labels.length > 0) {
    return {
      text: missingReadResponse(gaps.labels, evidence),
      blocked: true,
      unsupported: gaps.unsupported,
    };
  }

  return {
    text: verifiedReadResponse(request, evidence),
    blocked: false,
    unsupported: [],
  };
}

/** Replace unsupported action claims with a deterministic, evidence-based reply. */
export function enforceResponseContract(
  text: string,
  evidence: ActionEvidence[],
  opts?: ResponseContractOptions,
): ResponseContractResult {
  const readGrounding = enforcePersonalReadGrounding(evidence, opts);
  if (readGrounding) return readGrounding;
  const claimed = claimedKinds(text);
  const unsupported = claimed.filter(
    (kind) =>
      !supports(
        kind,
        evidence,
        (kind === 'workspace' || kind === 'spreadsheet' || kind === 'presentation') &&
          freshArtifactEditClaim(text, kind),
      ),
  );
  if (unsupported.length === 0) {
    // The action-claim rules passed, but a fabricated link can still ride along
    // in an otherwise-honest answer. Only meaningful with a corpus (the finalize
    // call site provides one; existing unit callers omit it and skip the rule).
    if (opts?.urlCorpus !== undefined) {
      const { text: cleaned, strippedUrls } = enforceUrlProvenance(text, opts.urlCorpus);
      if (strippedUrls.length > 0) {
        console.warn('stripped unverifiable url(s) from final answer', {
          strippedUrls,
        });
      }
      return { text: cleaned, blocked: false, unsupported: [] };
    }
    return { text, blocked: false, unsupported: [] };
  }
  if (unsupported.includes('approval')) {
    return {
      text: 'I did not create a real approval request, so nothing is waiting on the Approvals page. I stopped instead of showing an unverified approval code.',
      blocked: true,
      unsupported,
    };
  }
  // The confirm-list is scoped to what THIS turn claimed (in-scope only), so an
  // unrelated turn never reprints the whole conversation's ledger of artifacts.
  const claimedSet = new Set(claimed);
  return {
    text:
      partialFailureResponse(evidence, unsupported, claimedSet) ??
      transparentFailureResponse(evidence),
    blocked: true,
    unsupported,
  };
}
