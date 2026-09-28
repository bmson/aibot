import {
  type CallResult,
  getRate,
  reconcileReservation,
  recordCallResult,
  recordCostEvent,
} from '@assistant/core';
import { connectionIdForModel } from '@assistant/core/model-router';
import type {
  CallSession,
  CallSessionRepository,
  CallTranscriptLine,
  CostRepository,
  ExecutionJobRepository,
} from '@assistant/persistence';

export interface FinishDeps {
  calls: CallSessionRepository;
  costs: CostRepository;
  jobs: ExecutionJobRepository;
}

export interface FinishInput {
  status: 'completed' | 'no_answer' | 'busy' | 'failed' | 'canceled';
  outcome: CallResult['outcome'];
  summary: string;
  /** Connected seconds, as Twilio or the bridge measured them. */
  durationSeconds: number | null;
  /** Live voice model spend, already computed from its usage. */
  modelCostUsd: number;
  error?: string | null;
}

/**
 * End a call exactly once: settle what it cost, record the outcome, and wake
 * the task that is parked on it. Both the media bridge (connected calls) and
 * the status webhook (calls that never connected) call this; the repository's
 * `finish` lets only the first through, so the task wakes once and the
 * spend is counted once.
 */
export async function finishCall(
  deps: FinishDeps,
  session: CallSession,
  input: FinishInput,
): Promise<CallResult | null> {
  const minutes = input.durationSeconds ? Math.ceil(input.durationSeconds / 60) : 0;
  let twilioUsd = 0;
  try {
    const rate = await getRate(deps.costs, 'twilio_voice_min');
    twilioUsd = minutes * rate.unitPriceUsd;
    if (session.reservationId)
      await reconcileReservation(deps.costs, session.reservationId, {
        usd: twilioUsd,
        quantity: minutes,
        unit: rate.unit,
        unitPriceUsd: rate.unitPriceUsd,
        description: `phone call to ${session.to} (${minutes} min)`,
      });
  } catch (error) {
    // The call already happened; a metering failure must not keep the task asleep.
    console.error('call cost reconciliation failed', error);
  }

  const totalUsd = twilioUsd + input.modelCostUsd;
  const finished = await deps.calls.finish(session.id, {
    status: input.status,
    outcome: input.outcome,
    summary: input.summary.slice(0, 2_000),
    durationSeconds: input.durationSeconds,
    endedAt: new Date(),
    costUsd: totalUsd.toFixed(6),
    error: input.error ?? null,
  });
  if (!finished) return null;

  if (input.modelCostUsd > 0) {
    await recordCostEvent(deps.costs, {
      source: 'model',
      evidence: {
        basis: 'token_rate',
        provider: connectionIdForModel(session.voiceModel),
        model: session.voiceModel,
      },
      usd: input.modelCostUsd,
      taskId: session.taskId,
      description: `live voice model ${session.voiceModel} on a phone call`,
    }).catch((error) => console.error('call model cost event failed', error));
  }

  const transcript = ((finished.transcript as CallTranscriptLine[]) ?? []).map((line) => ({
    role: line.role === 'caller' ? 'them' : line.role,
    text: line.text,
  }));
  const result: CallResult = {
    callId: finished.id,
    to: finished.to,
    status: input.status,
    outcome: input.outcome,
    summary: input.summary,
    notes: (finished.notes as string[]) ?? [],
    durationSeconds: input.durationSeconds,
    // Enough for the task to report and follow up; the full record stays on /calls.
    transcript: transcript.slice(-80),
    costUsd: Number(totalUsd.toFixed(4)),
  };
  const woke = await recordCallResult(deps.jobs, {
    taskId: finished.taskId,
    token: finished.callbackToken,
    result,
  });
  if (!woke.ok) console.error('call result could not wake its task', woke.status, woke.error);
  return result;
}

/** Map a terminal Twilio call status onto our own. */
export function terminalStatus(twilioStatus: string): FinishInput['status'] | null {
  switch (twilioStatus) {
    case 'completed':
      return 'completed';
    case 'no-answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return null;
  }
}
