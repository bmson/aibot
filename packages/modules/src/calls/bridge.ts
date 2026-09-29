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
  TELEPHONE_RATE,
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
  /** How long to wait for the other party before introducing the call. */
  openingWaitMs?: number;
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

/** Keep at most ten seconds of caller audio while the voice model connects. */
const MAX_BUFFERED_AUDIO_BYTES = TELEPHONE_RATE * 10;

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
  const openingWaitMs = deps.openingWaitMs ?? 3_000;

  let streamSid = '';
  let session: CallSession | null = null;
  let streamClaim: Promise<CallSession | null> | null = null;
  let voice: ResolvedVoiceModel | null = null;
  let live: RealtimeSession | null = null;
  let connectedAt = 0;
  let ended = false;
  let finishing: Promise<void> | null = null;
  let heldAudio: Uint8Array[] = [];
  let heldAudioBytes = 0;
  let callerSpoke = false;
  let assistantSpoke = false;
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
    if (ended || !streamSid) return;
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

  const bufferAudio = (chunk: Uint8Array) => {
    if (chunk.length >= MAX_BUFFERED_AUDIO_BYTES) {
      heldAudio = [chunk.slice(chunk.length - MAX_BUFFERED_AUDIO_BYTES)];
      heldAudioBytes = MAX_BUFFERED_AUDIO_BYTES;
      return;
    }
    heldAudio.push(chunk);
    heldAudioBytes += chunk.length;
    while (heldAudioBytes > MAX_BUFFERED_AUDIO_BYTES) {
      const oldest = heldAudio.shift();
      if (!oldest) break;
      heldAudioBytes -= oldest.length;
    }
  };

  const flushHeldAudio = () => {
    if (!live) return;
    for (const chunk of heldAudio) live.sendAudio(chunk);
    heldAudio = [];
    heldAudioBytes = 0;
  };

  const onToolCall = async (call: RealtimeToolCall) => {
    if (!live || !session) return;
    assistantSpoke = true;
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
      if (!session && streamClaim) session = await streamClaim.catch(() => null);
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
        outcome: endResult?.outcome ?? 'not_achieved',
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
    if (ended) return;
    streamSid = message.start?.streamSid ?? message.streamSid ?? '';
    const params = message.start?.customParameters ?? {};
    streamClaim =
      params.callId && params.token
        ? deps.calls.claimStream(params.callId, hashCallbackToken(params.token), now())
        : Promise.resolve(null);
    const claimed = await streamClaim;
    if (!claimed) {
      socket.close();
      return;
    }
    session = claimed;
    connectedAt = Date.now();
    if (ended) return;
    const brief = claimed.brief as CallBrief;
    try {
      voice = await deps.resolveVoice(claimed);
      if (ended) return;
      const connectedLive = await voice.provider.connect(
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
            assistantSpoke = true;
            if (!replyStartedAt) replyStartedAt = Date.now();
            replyQueuedMs += mulaw.length / 8;
            sendAudio(mulaw);
          },
          speechStarted: () => {
            callerSpoke = true;
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
              assistantSpoke = true;
              replyStartedAt = 0;
              replyQueuedMs = 0;
            } else callerSpoke = true;
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
      if (ended) {
        await connectedLive.close().catch(() => {});
        return;
      }
      live = connectedLive;
    } catch (error) {
      if (ended) return;
      console.error('call could not start its voice model', error);
      endResult = {
        outcome: 'failed',
        summary: `The call connected but the voice model could not start: ${error instanceof Error ? error.message : String(error)}`,
      };
      hangup();
      return;
    }
    // A screening prompt can arrive while the model connects. Let it hear
    // those frames before deciding whether it needs to introduce the call.
    flushHeldAudio();
    timers.push(setInterval(() => void poll(), pollMs));
    timers.push(
      setTimeout(() => {
        if (ended || !live || callerSpoke || assistantSpoke) return;
        live.respond(
          'If someone is speaking, listen and answer them. Otherwise, introduce yourself by name as an AI assistant calling for the owner, say the call is transcribed, and briefly state the approved reason for calling. If this is a call screener, wait for it to connect the person.',
        );
      }, openingWaitMs),
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
    if (message.event === 'media' && message.media?.payload && streamSid && !ended) {
      const chunk = new Uint8Array(Buffer.from(message.media.payload, 'base64'));
      if (live) live.sendAudio(chunk);
      else bufferAudio(chunk);
      return;
    }
    if (message.event === 'stop') void finalize();
  });
  socket.on('close', () => void finalize());
  socket.on('error', (error) => console.error('call media socket error', error.message));
}
