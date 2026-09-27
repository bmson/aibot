import type { CallSession } from '@assistant/persistence';
import { twimlText } from '@assistant/tools/calls';
import { type FinishDeps, finishCall, terminalStatus } from './finish.js';

export interface StatusDeps extends FinishDeps {
  notifyOwner(input: { text: string; taskId?: string }): Promise<void>;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/**
 * Twilio's progress and answering-machine callbacks for a placed call. The
 * bridge finishes calls that connected; this finishes the ones that never did
 * (no answer, busy, failed, or hung up during the disclosure).
 */
export async function handleCallStatus(
  deps: StatusDeps,
  params: Record<string, string>,
): Promise<{ status: number; text: string; contentType: string }> {
  const reply = { status: 200, text: EMPTY_TWIML, contentType: 'text/xml' };
  const callSid = params.CallSid ?? '';
  if (!/^CA[0-9a-f]{32}$/i.test(callSid)) return reply;
  const session = await deps.calls.getByCallSid(callSid);
  if (!session) return reply;

  if (params.AnsweredBy && !session.answeredBy)
    await deps.calls.update(session.id, { answeredBy: params.AnsweredBy.slice(0, 40) });

  const callStatus = params.CallStatus ?? '';
  if (callStatus === 'ringing' && session.status === 'dialing') {
    await deps.calls.update(session.id, { status: 'ringing' });
    return reply;
  }
  const terminal = terminalStatus(callStatus);
  if (!terminal || session.startedAt) return reply;

  const duration = Number(params.CallDuration);
  await finishCall(deps, session, {
    status: terminal,
    outcome:
      terminal === 'completed' ? 'not_achieved' : terminal === 'no_answer' ? 'no_answer' : 'failed',
    summary: neverConnectedSummary(session, terminal),
    durationSeconds: Number.isFinite(duration) ? duration : null,
    modelCostUsd: 0,
    error: terminal === 'failed' ? (params.ErrorMessage ?? params.SipResponseCode ?? null) : null,
  });
  return reply;
}

function neverConnectedSummary(session: CallSession, status: string): string {
  const who = session.contactName ?? session.to;
  switch (status) {
    case 'no_answer':
      return `${who} did not answer.`;
    case 'busy':
      return `${who}'s line was busy.`;
    case 'canceled':
      return 'The call was canceled before it connected.';
    case 'completed':
      return `${who} hung up before the conversation started.`;
    default:
      return `The call to ${who} could not be placed.`;
  }
}

/**
 * Someone called the assistant's number — often a business calling back. It
 * answers with a short notice and tells the owner who called.
 */
export async function handleInboundCall(
  deps: { notifyOwner(input: { text: string }): Promise<void>; ownerName: string },
  params: Record<string, string>,
): Promise<{ status: number; text: string; contentType: string }> {
  const from = params.From ?? 'an unknown number';
  await deps
    .notifyOwner({
      text: `${from} called the assistant's number. They heard that it doesn't take calls.`,
    })
    .catch((error) => console.error('inbound call notice failed', error));
  const owner = deps.ownerName.trim() || 'the owner';
  return {
    status: 200,
    contentType: 'text/xml',
    text: `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${twimlText(
      `Hi, you've reached an AI assistant line for ${owner}. It only places calls and can't take messages here. ${owner} has been told you called. Goodbye.`,
    )}</Say><Hangup/></Response>`,
  };
}
