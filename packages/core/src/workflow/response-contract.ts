/**
 * The model writes prose, but the task/tool ledger is the authority for what
 * happened. This module is deliberately conservative: when a reply describes
 * an external action without matching evidence, replace it with a transparent
 * response instead of publishing a convincing but false status update.
 */

export interface ActionEvidence {
  toolName: string;
  status: string;
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
  | 'research'
  | 'background';

export interface ResponseContractResult {
  text: string;
  blocked: boolean;
  unsupported: ActionKind[];
}

const OUTBOUND_OBJECTS = 'email|message|sms|text|call|outreach|reply|follow-?up';
const APPLICATION_OBJECTS =
  'application|applications|job application|application form|career portal|form submission|jobs?|roles?|positions?';
const CALENDAR_OBJECTS = 'calendar|calendar event|event|appointment|meeting|interview';
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
const CURRENT_TASK_ONLY: ReadonlySet<ActionKind> = new Set(['outbound', 'application', 'calendar']);

function inScope(kind: ActionKind, item: ActionEvidence): boolean {
  return !CURRENT_TASK_ONLY.has(kind) || item.fromCurrentTask !== false;
}

function supports(kind: ActionKind, evidence: ActionEvidence[]): boolean {
  const usable = evidence.filter((item) => successful(item) && inScope(kind, item));
  const names = usable.map((item) => item.toolName);
  switch (kind) {
    case 'workspace':
      return names.some(
        (name) =>
          /^(docs\.(?:create|append|share)|workspace\.write)$/.test(name) ||
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
    case 'research':
      return names.some((name) => name === 'web.fetch' || name === 'browser.execute');
    case 'background':
      return names.some(
        (name) =>
          name === 'mission.update' ||
          name === 'task.schedule' ||
          name === 'applications.watch_confirmation',
      );
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
  const detail = failures.length
    ? ` The attempted action did not complete (${failures.join('; ')}).`
    : ' No supporting tool action completed.';
  return [
    "I can't claim that work was completed.",
    detail,
    'I have not created, sent, submitted, researched, or updated anything outside this chat for this request.',
    'I can only report an action after the required tool is available and returns a successful result.',
  ].join(' ');
}

const UNSUPPORTED_LABEL: Record<ActionKind, string> = {
  workspace: 'the requested document or file action',
  spreadsheet: 'the requested spreadsheet or tracker action',
  presentation: 'the requested presentation action',
  outbound: 'the requested outbound message',
  application: 'the application submission',
  calendar: 'the requested calendar action',
  research: 'the requested research',
  background: 'the promised background work',
};

function describeTool(name: string): string | undefined {
  if (name === 'drive.download') return 'the requested Drive file was staged';
  if (/^docs\.(?:create|append|share)$/.test(name)) return 'the Google Doc action completed';
  if (name === 'workspace.write') return 'the workspace file was written';
  if (/^sheets\.(?:create|append_rows|write_rows)$/.test(name)) {
    return 'the Google Sheet action completed';
  }
  if (/^slides\.(?:create|append)$/.test(name)) return 'the Google Slides action completed';
  if (name === 'gmail.send') return 'the email was sent';
  if (name === 'sms.send' || name === 'email.send') return 'the message was sent';
  if (/^calendar\.(create|update|cancel|delete)/.test(name)) return 'the calendar action completed';
  if (name === 'web.fetch') return 'the web request completed';
  if (name === 'application.submit') return 'the application was submitted';
  if (name === 'applications.watch_confirmation') return 'the confirmation watch was created';
  if (name === 'mission.update' || name === 'task.schedule') {
    return 'the background task was created or updated';
  }
  return undefined;
}

/**
 * Prior-turn evidence is real, but reporting it unqualified would imply the
 * work happened in response to *this* request. Say when it happened.
 */
function verifiedActionDescriptions(evidence: ActionEvidence[]): string[] {
  const descriptions = new Set<string>();
  for (const item of evidence) {
    if (!successful(item)) continue;
    const when = item.fromCurrentTask === false ? ' earlier in this conversation' : '';
    const described = describeTool(item.toolName);
    if (described) descriptions.add(`${described}${when}`);
    if (browserApplicationConfirmed(item)) {
      descriptions.add(`the portal returned an explicit application confirmation${when}`);
    }
  }
  return [...descriptions];
}

function partialFailureResponse(
  evidence: ActionEvidence[],
  unsupported: ActionKind[],
): string | undefined {
  const verified = verifiedActionDescriptions(evidence);
  if (verified.length === 0) return undefined;
  const missing = [...new Set(unsupported.map((kind) => UNSUPPORTED_LABEL[kind]))];
  const failures = failureDetails(evidence);
  const failureDetail = failures.length
    ? ` The incomplete action reported: ${failures.join('; ')}.`
    : '';
  return `I can verify that ${verified.join('; ')}. I cannot verify ${missing.join(' or ')} from successful tool evidence, so I am not claiming it completed.${failureDetail}`;
}

/** Replace unsupported action claims with a deterministic, evidence-based reply. */
export function enforceResponseContract(
  text: string,
  evidence: ActionEvidence[],
): ResponseContractResult {
  const unsupported = claimedKinds(text).filter((kind) => !supports(kind, evidence));
  if (unsupported.length === 0) return { text, blocked: false, unsupported: [] };
  return {
    text: partialFailureResponse(evidence, unsupported) ?? transparentFailureResponse(evidence),
    blocked: true,
    unsupported,
  };
}
