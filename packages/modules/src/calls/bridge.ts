import { randomUUID } from 'node:crypto';
import {
  type CallBrief,
  type CallResult,
  callInstructions,
  hashCallbackToken,
} from '@assistant/core';
import {
  DTMF_DIGITS,
  dtmfMulaw,
  mulawFrames,
  type RealtimeSession,
  type RealtimeToolCall,
  type RealtimeToolSpec,
  type ResolvedVoiceModel,
  realtimeCostUsd,
} from '@assistant/core/realtime-voice';
import type {
  CallCheckin,
  CallSession,
  CallSessionRepository,
  CallTranscriptLine,
} from '@assistant/persistence';
import type { VoiceDialer } from '@assistant/tools/calls';
import { type FinishDeps, type FinishInput, finishCall } from './finish.js';

/** The slice of a WebSocket the bridge uses (ws's WebSocket satisfies it). */
export interface MediaSocket {
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string): void;
  close(): void;
}

export interface BridgeDeps extends FinishDeps {
  calls: CallSessionRepository;
  dialer: VoiceDialer;
  /** The live voice model the call should use. Throws when none is usable. */
  resolveVoice(session: CallSession): Promise<ResolvedVoiceModel>;
  /** Push/SMS the owner (check-ins). */
  notifyOwner(input: { text: string; taskId?: string }): Promise<void>;
  /** Where the owner answers a check-in, e.g. https://…/calls/<id>. */
  callUrl(callId: string): string;
  ownerName: string;
  assistantName: string;
  timezone: string;
  now?: () => Date;
  pollMs?: number;
  checkinWaitMs?: number;
  /** How long caller audio is held for the answering-machine verdict. */
  amdHoldMs?: number;
}

const TOOLS: RealtimeToolSpec[] = [
  {
    name: 'ask_owner',
    description:
      'Ask the owner a question mid-call when the other party needs a decision outside what you may agree to. Say "one moment, let me check" BEFORE calling this. Waits up to a minute for the answer.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'One short, specific question.' } },
      required: ['question'],
    },
  },
  {
    name: 'press_keys',
    description:
      'Press phone keys to navigate a phone menu (digits 0-9, *, #; "w" waits half a second).',
    parameters: {
      type: 'object',
      properties: { digits: { type: 'string' } },
      required: ['digits'],
    },
  },
  {
    name: 'note',
    description:
      'Record a concrete fact learned on the call (a time, price, name, or reference number).',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string' } },
      required: ['fact'],
    },
  },
  {
    name: 'end_call',
    description: 'Hang up after saying goodbye, recording how the call went.',
    parameters: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['achieved', 'partially_achieved', 'not_achieved', 'voicemail'],
        },
        summary: {
          type: 'string',
          description: 'Two or three sentences for the owner: what was agreed, what is still open.',
        },
      },
      required: ['outcome', 'summary'],
    },
  },
];

const MACHINE = /^machine_end_|^fax$/;

type TwilioStreamMessage = {
  event?: string;
  streamSid?: string;
  start?: { streamSid?: string; callSid?: string; customParameters?: Record<string, string> };
  media?: { payload?: string; track?: string };
};

/**
 * One live call: Twilio's bidirectional media stream on one side, the
 * realtime voice model on the other, and the call session in storage as the
 * shared state other agent instances (webhooks, the owner's answer) write to.
 */
export function handleMediaStream(socket: MediaSocket, deps: BridgeDeps): void {
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? 1_000;
  const checkinWaitMs = deps.checkinWaitMs ?? 60_000;
  const amdHoldMs = deps.amdHoldMs ?? 8_000;

  let streamSid = '';
  let session: CallSession | null = null;
  let voice: ResolvedVoiceModel | null = null;
  let live: RealtimeSession | null = null;
  let connectedAt = 0;
  let ended = false;
  let finishing: Promise<void> | null = null;
  let heldAudio: Uint8Array[] = [];
  let released = false;
  let voicemailHandled = false;
  let reachedVoicemail = false;
  let wrapUpSent = false;
  let endResult: { outcome: CallResult['outcome']; summary: string } | null = null;
  let hangupTimer: NodeJS.Timeout | null = null;
  // Playback accounting for barge-in: when the current reply started and how
  // much audio has been queued to the line since.
  let replyStartedAt = 0;
  let replyQueuedMs = 0;
  const transcriptBuffer: CallTranscriptLine[] = [];
  const waiters = new Map<string, (answer: string | null) => void>();
  const timers: NodeJS.Timeout[] = [];

  const sendAudio = (mulaw: Uint8Array) => {
    if (!streamSid) return;
    for (const frame of mulawFrames(mulaw)) {
      socket.send(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: Buffer.from(frame).toString('base64') },
        }),
      );
    }
  };

  const remainingPlaybackMs = () =>
    replyStartedAt ? Math.max(0, replyQueuedMs - (Date.now() - replyStartedAt)) : 0;

  const hangup = (delayMs = 0) => {
    if (hangupTimer || !session?.twilioCallSid) return;
    const sid = session.twilioCallSid;
    hangupTimer = setTimeout(() => {
      deps.dialer.hangup(sid).catch((error) => console.error('call hangup failed', error));
    }, delayMs);
  };

  const flushTranscript = async () => {
    if (!session || transcriptBuffer.length === 0) return;
    const lines = transcriptBuffer.splice(0);
    await deps.calls.appendTranscript(session.id, lines).catch((error) => {
      console.error('call transcript write failed', error);
    });
  };

  const release = () => {
    if (released || !live) return;
    released = true;
    for (const chunk of heldAudio) live.sendAudio(chunk);
    heldAudio = [];
  };

  const handleVoicemail = (brief: CallBrief) => {
    if (voicemailHandled || !live) return;
    voicemailHandled = true;
    reachedVoicemail = true;
    if (brief.onVoicemail === 'leave_message' && brief.voicemailMessage) {
      released = true;
      heldAudio = [];
      live.respond(
        `You reached voicemail and the beep has sounded. Say exactly this message, then call end_call with outcome "voicemail": ${brief.voicemailMessage}`,
      );
    } else {
      endResult = {
        outcome: 'voicemail',
        summary: 'Reached voicemail; hung up without leaving a message.',
      };
      hangup();
    }
  };

  const onToolCall = async (call: RealtimeToolCall) => {
    if (!live || !session) return;
    const args = (call.args ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case 'ask_owner': {
        const question = String(args.question ?? '').slice(0, 300);
        const checkin: CallCheckin = {
          id: randomUUID(),
          question,
          askedAt: now().toISOString(),
          answer: null,
          answeredAt: null,
          via: null,
        };
        await deps.calls.addCheckin(session.id, checkin);
        const who = session.contactName ?? session.to;
        await deps
          .notifyOwner({
            taskId: session.taskId,
            text: `On the phone with ${who}: "${question}" Answer here: ${deps.callUrl(session.id)}`,
          })
          .catch((error) => console.error('check-in notice failed', error));
        const answer = await new Promise<string | null>((resolve) => {
          waiters.set(checkin.id, resolve);
          timers.push(
            setTimeout(() => {
              if (waiters.delete(checkin.id)) resolve(null);
            }, checkinWaitMs),
          );
        });
        live.sendToolResult(
          call,
          answer === null
            ? {
                answer: null,
                instruction:
                  'The owner has not answered yet. Tell them you will confirm and get back to them; do not commit.',
              }
            : { answer },
        );
        return;
      }
      case 'press_keys': {
        const digits = String(args.digits ?? '');
        if (!DTMF_DIGITS.test(digits)) {
          live.sendToolResult(call, { error: 'digits must be 0-9, *, #, A-D or w' });
          return;
        }
        sendAudio(dtmfMulaw(digits));
        transcriptBuffer.push({
          role: 'system',
          text: `Pressed ${digits}`,
          at: now().toISOString(),
        });
        live.sendToolResult(call, { pressed: digits });
        return;
      }
      case 'note': {
        const fact = String(args.fact ?? '').trim();
        if (fact) await deps.calls.appendNote(session.id, fact);
        live.sendToolResult(call, { noted: true });
        return;
      }
      case 'end_call': {
        const outcome = String(args.outcome ?? 'not_achieved');
        endResult = {
          outcome: (['achieved', 'partially_achieved', 'not_achieved', 'voicemail'].includes(
            outcome,
          )
            ? outcome
            : 'not_achieved') as CallResult['outcome'],
          summary: String(args.summary ?? '').slice(0, 1_000),
        };
        live.sendToolResult(call, { ok: true });
        // Let the goodbye finish playing before the line drops.
        hangup(remainingPlaybackMs() + 900);
        return;
      }
      default:
        live.sendToolResult(call, { error: `unknown tool ${call.name}` });
    }
  };

  const poll = async () => {
    if (!session || ended) return;
    await flushTranscript();
    const current = await deps.calls.get(session.id).catch(() => null);
    if (!current) return;
    session = current;
    if (current.hangupRequested && !endResult) {
      endResult = { outcome: 'not_achieved', summary: 'The owner ended the call.' };
      hangup();
    }
    const brief = current.brief as CallBrief;
    if (current.answeredBy && MACHINE.test(current.answeredBy)) handleVoicemail(brief);
    else if (current.answeredBy) release();
    for (const checkin of (current.checkins as CallCheckin[]) ?? []) {
      if (checkin.answer === null) continue;
      const resolve = waiters.get(checkin.id);
      if (resolve) {
        waiters.delete(checkin.id);
        resolve(checkin.answer);
      }
    }
    const elapsedMs = Date.now() - connectedAt;
    const limitMs = current.maxMinutes * 60_000;
    if (!wrapUpSent && elapsedMs > limitMs - 60_000 && live) {
      wrapUpSent = true;
      live.respond('You have about one minute left on this call. Wrap up politely now.');
    }
    if (elapsedMs > limitMs) {
      endResult ??= { outcome: 'not_achieved', summary: 'The call reached its time limit.' };
      hangup();
    }
  };

  const finalize = async () => {
    if (finishing) return finishing;
    finishing = (async () => {
      ended = true;
      for (const timer of timers) clearTimeout(timer);
      if (hangupTimer) clearTimeout(hangupTimer);
      for (const resolve of waiters.values()) resolve(null);
      waiters.clear();
      const usage = live?.usage();
      await live?.close().catch(() => {});
      if (!session) return;
      await flushTranscript();
      let durationSeconds: number | null = connectedAt
        ? Math.max(1, Math.round((Date.now() - connectedAt) / 1000))
        : null;
      if (session.twilioCallSid) {
        // Twilio's own duration is what it bills; it settles within seconds.
        for (let attempt = 0; attempt < 5; attempt++) {
          const details = await deps.dialer.getCall(session.twilioCallSid).catch(() => null);
          if (details?.status === 'completed' && details.durationSeconds !== null) {
            durationSeconds = details.durationSeconds;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      const notes = ((await deps.calls.get(session.id))?.notes as string[] | undefined) ?? [];
      const result: FinishInput = {
        status: 'completed',
        outcome: endResult?.outcome ?? (reachedVoicemail ? 'voicemail' : 'not_achieved'),
        summary:
          endResult?.summary ||
          (notes.length
            ? `The call ended before a wrap-up. Noted: ${notes.join('; ')}`
            : 'The call ended before the assistant finished.'),
        durationSeconds,
        modelCostUsd: usage && voice ? realtimeCostUsd(usage, voice.rates) : 0,
      };
      await finishCall(deps, session, result);
    })().catch((error) => console.error('call finalize failed', error));
    return finishing;
  };

  const start = async (message: TwilioStreamMessage) => {
    streamSid = message.start?.streamSid ?? message.streamSid ?? '';
    const params = message.start?.customParameters ?? {};
    const claimed =
      params.callId && params.token
        ? await deps.calls.claimStream(params.callId, hashCallbackToken(params.token), now())
        : null;
    if (!claimed) {
      socket.close();
      return;
    }
    session = claimed;
    connectedAt = Date.now();
    const brief = claimed.brief as CallBrief;
    try {
      voice = await deps.resolveVoice(claimed);
      live = await voice.provider.connect(
        {
          model: voice.model,
          voice: voice.voice,
          instructions: callInstructions({
            assistantName: deps.assistantName,
            ownerName: deps.ownerName,
            brief,
            now: now(),
            timezone: deps.timezone,
          }),
          tools: TOOLS,
        },
        {
          audio: (mulaw) => {
            if (!replyStartedAt) replyStartedAt = Date.now();
            replyQueuedMs += mulaw.length / 8;
            sendAudio(mulaw);
          },
          speechStarted: () => {
            if (!streamSid) return;
            socket.send(JSON.stringify({ event: 'clear', streamSid }));
            const playedMs = replyStartedAt
              ? Math.min(replyQueuedMs, Date.now() - replyStartedAt)
              : 0;
            live?.interrupt(playedMs);
            replyStartedAt = 0;
            replyQueuedMs = 0;
          },
          transcript: (role, text) => {
            if (role === 'assistant') {
              replyStartedAt = 0;
              replyQueuedMs = 0;
            }
            transcriptBuffer.push({ role, text, at: now().toISOString() });
          },
          toolCall: (call) => {
            onToolCall(call).catch((error) => console.error('call tool failed', error));
          },
          error: (error) => console.error('live voice session error', error.message),
          closed: () => {
            if (!ended) hangup();
          },
        },
      );
    } catch (error) {
      console.error('call could not start its voice model', error);
      endResult = {
        outcome: 'failed',
        summary: `The call connected but the voice model could not start: ${error instanceof Error ? error.message : String(error)}`,
      };
      hangup();
      return;
    }
    timers.push(setInterval(() => void poll(), pollMs));
    // Hold the caller's audio for the answering-machine verdict, then let the
    // conversation begin even without one.
    timers.push(
      setTimeout(() => {
        if (!voicemailHandled) release();
      }, amdHoldMs),
    );
  };

  socket.on('message', (raw) => {
    let message: TwilioStreamMessage;
    try {
      message = JSON.parse(
        Buffer.isBuffer(raw) ? raw.toString() : String(raw),
      ) as TwilioStreamMessage;
    } catch {
      return;
    }
    if (message.event === 'start') {
      start(message).catch((error) => {
        console.error('call stream start failed', error);
        socket.close();
      });
      return;
    }
    if (message.event === 'media' && message.media?.payload && live && !ended) {
      const chunk = new Uint8Array(Buffer.from(message.media.payload, 'base64'));
      if (released) live.sendAudio(chunk);
      else if (!voicemailHandled) heldAudio.push(chunk);
      return;
    }
    if (message.event === 'stop') void finalize();
  });
  socket.on('close', () => void finalize());
  socket.on('error', (error) => console.error('call media socket error', error.message));
}
