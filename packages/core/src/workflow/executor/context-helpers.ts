import type { TaskRow } from '@assistant/db';
import { nextDailyReset, nextMonthlyReset } from '../../cost.js';
import { activeAutonomyGrant } from '../autonomy.js';

/**
 * Trigger-payload marker for the D9 known-sender reply child: an assistant-trust
 * adhoc task whose sole job is to propose a pre-drafted reply back to a known
 * (authenticated non-owner) email sender, gated by gmail.send's owner approval.
 */
export const KNOWN_SENDER_REPLY_KIND = 'known_sender_reply';

export function isKnownSenderReplyTask(task: Pick<TaskRow, 'trigger'>): boolean {
  const trigger = task.trigger as { payload?: { kind?: unknown } } | null;
  return trigger?.payload?.kind === KNOWN_SENDER_REPLY_KIND;
}

/**
 * A mission work session, identified by the mission id its trigger carries
 * (missions.ts stamps it). Only such a session may see the mission.update tool;
 * keying off this — rather than "any adhoc child" — stops unrelated adhoc
 * children (e.g. the D9 known-sender-reply child) from being offered a tool they
 * can only ever call in error.
 */
export function isMissionSessionTask(task: Pick<TaskRow, 'trigger'>): boolean {
  const trigger = task.trigger as { payload?: { missionId?: unknown } } | null;
  return typeof trigger?.payload?.missionId === 'string';
}

/**
 * A goal's automatic work session runs with nobody watching it. A run that
 * ends without a single verified tool result therefore must not complete as
 * 'done': the owner sees a green task, the goal keeps its old progress line,
 * and the next session is re-seeded with the same stale state — the goal
 * silently spins. Chat turns are excluded on purpose; there the owner is
 * reading the same honesty message in real time.
 */
export function isUnattendedGoalSession(task: Pick<TaskRow, 'goalId' | 'type'>): boolean {
  return task.goalId !== null && task.type !== 'chat_turn' && task.type !== 'sms_turn';
}

/** Where budget-parked work resumes: the reset of whichever period is exhausted. */
export function budgetResumeAt(reason: string): Date {
  return reason.includes('monthly') ? nextMonthlyReset() : nextDailyReset();
}

/**
 * Where this task's final answer lands — the model writes very different
 * replies for an email thread than for a chat bubble, and must know that
 * delivery back through the source channel is automatic.
 */
export function channelContext(task: TaskRow): string {
  const payload = (task.trigger as { payload?: Record<string, unknown> } | null)?.payload ?? {};
  switch (task.type) {
    case 'email_triage': {
      const from = typeof payload.from === 'string' ? payload.from : 'the sender';
      const subject = typeof payload.subject === 'string' ? payload.subject : '';
      return [
        `\nThis task was triggered by an email from ${from}${subject ? ` (subject: "${subject}")` : ''}.`,
        task.trust === 'owner'
          ? 'When you finish with a text answer, it is AUTOMATICALLY emailed back to the sender on the same thread — write your final message as that email reply (a short greeting, the substance, and a brief sign-off as yourself), and complete any needed tool actions (calendar, lookups) BEFORE finishing. Email renders simple Markdown as rich text, so you may use **bold**, bullet lists, and [labelled links](https://…); do not paste bare URLs mid-sentence.'
          : 'The sender is not the owner: nothing is auto-sent. If a reply is warranted, use gmail.create_draft (or gmail.send, which needs owner approval).',
      ].join('\n');
    }
    case 'sms_turn':
      return '\nThis task came in by SMS; your final text goes back as an SMS — one or two plain sentences, no greeting or sign-off, no markdown.';
    case 'chat_turn':
      return "\nThis task came from the owner's dashboard chat; your final text appears there as your reply.";
    default:
      if (task.goalId) {
        const freeRange = activeAutonomyGrant(task, Date.now()) !== null;
        if (freeRange) {
          // Free-range goal session: the grant means a lookup no longer forfeits
          // the ability to act, so the model may ground itself first and then act.
          return [
            "\nThis is a goal's automatic work session, running free-range: the owner armed it to work autonomously, so you can consult your own state AND act without stopping for approval on each step.",
            'Do the work now with your tools — do not describe a plan, promise to report back, or ask a question you could answer yourself by looking.',
            'Ground yourself first if it helps (memory.recall, goals.list, contacts.lookup), then take the outward step that moves the goal (browser.plan → browser.execute, or web.fetch for a plain page).',
            'Not knowing a URL is not a blocker: go to the most likely site. A "verify you are human"/CAPTCHA page is a block, never content.',
            'Finish by calling goals.update_progress with what you verified and the concrete next step.',
          ].join('\n');
        }
        // Nobody is reading this live, so a message describing what you intend
        // to do reaches no one and changes nothing. Only a tool result does.
        return [
          "\nThis is a goal's automatic work session. The owner is NOT present and will not answer during this run.",
          'Do the work now with your tools — do not describe a plan, promise to report back, or ask a question you could answer yourself by looking.',
          'Everything you know about this goal is already in this prompt. Do NOT re-read your own state: goals.list, memory.recall, conversations.search and workspace.* tell you nothing new here.',
          // Not a style preference — the provenance rule below makes call order
          // decide whether this session can act at all.
          'ORDER MATTERS. Reading anything marks this session as carrying untrusted content, and from that point on every outward call needs the owner to approve it by hand — which, with nobody present, means the session stops. So spend your FIRST tool call on the outward step that moves the goal: browser.plan, then browser.execute (or web.fetch for a plain page). Any lookup you do first permanently costs you the ability to browse this run.',
          'You get one autonomous outward action, so make it count. browser.plan is free — it only plans. Your ONE outward call comes after it, and it must do the entire job: a single read-only browser.execute plan that searches, opens the promising results, and extracts everything you need. Do not spend that one action on a preliminary web.fetch to see what is there; if you would need several pages, ask browser.plan for a headless plan covering all of them.',
          'Not knowing a URL is not a blocker: go straight to the most likely site (official pages, Wikipedia/Wikivoyage, a company careers page). Big search engines CAPTCHA datacenter traffic — treat a search results page as a last resort, and a "verify you are human" page as a block, never as content.',
          'Finish by calling goals.update_progress with what you verified and the concrete next step.',
        ].join('\n');
      }
      return '';
  }
}
