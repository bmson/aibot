import { createHash } from 'node:crypto';
import type {
  RealtimeSession,
  RealtimeSessionConfig,
  RealtimeSessionEvents,
  ResolvedVoiceModel,
} from '@assistant/core/realtime-voice';
import {
  ACTIVE_CALL_STATUSES,
  type CallCheckin,
  type CallSession,
  type CallSessionRepository,
  type CallTranscriptLine,
} from '@assistant/persistence';
import type { VoiceDialer } from '@assistant/tools/calls';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  reserveCost: vi.fn(),
  releaseReservation: vi.fn(async (_costs: unknown, _id: string) => {}),
  reconcileReservation: vi.fn(async (_costs: unknown, _id: string, _input: unknown) => {}),
  recordCostEvent: vi.fn(async (_costs: unknown, _input: unknown) => {}),
  recordCallResult: vi.fn(async (_jobs: unknown, _input: unknown) => ({
    ok: true,
    taskId: 't',
    queueGeneration: 1,
  })),
  getRate: vi.fn(async () => ({ unitPriceUsd: 0.014, unit: 'minute' })),
}));
vi.mock('@assistant/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core')>()),
  ...core,
}));

const { handleMediaStream } = await import('./bridge.js');
type MediaSocket = import('./bridge.js').MediaSocket;
const { startCall, mediaStreamUrl } = await import('./dial.js');
const { handleCallStatus } = await import('./status.js');

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function memoryCalls(): CallSessionRepository & { rows: Map<string, CallSession> } {
  const rows = new Map<string, CallSession>();
  const patch = (id: string, change: Partial<CallSession>) => {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, ...change, updatedAt: new Date() });
  };
  const active = (row: CallSession) =>
    (ACTIVE_CALL_STATUSES as readonly string[]).includes(row.status);
  return {
    kind: 'call-session-repository',
    rows,
    async create(input) {
      const row: CallSession = {
        ...input,
        createdAt: new Date(),
        updatedAt: new Date(),
        twilioCallSid: null,
        answeredBy: null,
        startedAt: null,
        endedAt: null,
        durationSeconds: null,
        transcript: [],
        notes: [],
        checkins: [],
        hangupRequested: false,
        outcome: null,
        summary: null,
        costUsd: null,
        error: null,
      };
      rows.set(row.id, row);
      return row;
    },
    get: async (id) => rows.get(id) ?? null,
    getByCallSid: async (sid) =>
      [...rows.values()].find((row) => row.twilioCallSid === sid) ?? null,
    list: async () => [...rows.values()],
    countSince: async (_agent, since) =>
      [...rows.values()].filter((r) => r.createdAt >= since).length,
    activeCount: async () => [...rows.values()].filter(active).length,
    update: async (id, change) => patch(id, change),
    async claimStream(id, tokenHash, now) {
      const row = rows.get(id);
      if (!row?.streamTokenHash || row.streamTokenHash !== tokenHash || !active(row)) return null;
      patch(id, { streamTokenHash: null, status: 'in_progress', startedAt: now });
      return rows.get(id) ?? null;
    },
    async finish(id, change) {
      const row = rows.get(id);
      if (!row || !active(row)) return null;
      patch(id, change);
      return rows.get(id) ?? null;
    },
    appendTranscript: async (id, lines) =>
      patch(id, {
        transcript: [...((rows.get(id)?.transcript as CallTranscriptLine[]) ?? []), ...lines],
      }),
    appendNote: async (id, note) =>
      patch(id, { notes: [...((rows.get(id)?.notes as string[]) ?? []), note] }),
    addCheckin: async (id, checkin) =>
      patch(id, { checkins: [...((rows.get(id)?.checkins as CallCheckin[]) ?? []), checkin] }),
    async answerCheckin(_agent, id, checkinId, answer, via) {
      const checkins = (rows.get(id)?.checkins as CallCheckin[]) ?? [];
      if (!checkins.some((c) => c.id === checkinId && c.answer === null)) return false;
      patch(id, {
        checkins: checkins.map((c) =>
          c.id === checkinId ? { ...c, answer, via, answeredAt: new Date().toISOString() } : c,
        ),
      });
      return true;
    },
    async requestHangup(_agent, id) {
      const row = rows.get(id);
      if (!row || !active(row)) return false;
      patch(id, { hangupRequested: true });
      return true;
    },
  };
}

function fakeDialer(): VoiceDialer & {
  placeCall: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
} {
  return {
    configured: () => true,
    placeCall: vi.fn(async () => ({ sid: `CA${'a'.repeat(32)}` })),
    hangup: vi.fn(async () => {}),
    getCall: vi.fn(async () => ({
      status: 'completed',
      durationSeconds: 95,
      priceUsd: null,
      answeredBy: null,
    })),
  };
}

const brief = {
  to: '+14155550123',
  contactName: 'Nopa',
  goal: 'Book a table for two at 7:30pm tonight.',
  context: 'Name: Baldvin Smarason.',
  mayAgreeTo: 'Any time between 7 and 8:30pm.',
  mustNot: 'Pay a deposit.',
  language: 'English',
  maxMinutes: 10,
  onVoicemail: 'hang_up' as const,
};

const rates = {
  audioInputPerMTok: 32,
  audioOutputPerMTok: 64,
  textInputPerMTok: 4,
  textOutputPerMTok: 24,
};

beforeEach(() => {
  vi.clearAllMocks();
  core.reserveCost.mockResolvedValue({ ok: true, reservationId: 'res-1' });
});

function dialDeps(calls: CallSessionRepository, dialer: VoiceDialer) {
  return {
    config: {
      PUBLIC_URL: 'https://agent.example.run.app',
      OWNER_NAME: 'Baldvin',
      CALL_DAILY_LIMIT: 3,
      CALL_MAX_MINUTES: 8,
    },
    calls,
    costs: {} as never,
    dialer,
    ownerId: async () => 'agent-1',
    voiceModel: async () => ({
      id: 'openai:gpt-realtime-2.1',
      resolved: {
        provider: {} as never,
        model: 'gpt-realtime-2.1',
        rates,
      } satisfies ResolvedVoiceModel,
    }),
  };
}

function toolInput(callId = '11111111-1111-4111-8111-111111111111') {
  return {
    callId,
    brief,
    callbackToken: 'wake-token',
    ctx: {
      taskId: '22222222-2222-4222-8222-222222222222',
      now: () => new Date(),
      execution: {
        dbToolCallId: '33333333-3333-4333-8333-333333333333',
        modelToolCallId: 'm',
        toolName: 'phone.call',
      },
    } as never,
  };
}

describe('placing a call', () => {
  it('holds the worst-case cost, records the session, and dials with the fixed disclosure', async () => {
    const calls = memoryCalls();
    const dialer = fakeDialer();
    const result = await startCall(dialDeps(calls, dialer), toolInput());
    expect(result).toEqual({ callSid: `CA${'a'.repeat(32)}` });

    // 8 minutes (the installation cap beats the brief's 10) of line + model.
    const reservation = core.reserveCost.mock.calls[0]?.[1] as { estimatedUsd: number } | undefined;
    expect(reservation?.estimatedUsd).toBeCloseTo(8 * (0.014 + (6000 * 32 + 1500 * 64) / 1e6));

    const session = calls.rows.get('11111111-1111-4111-8111-111111111111');
    expect(session).toMatchObject({
      status: 'dialing',
      maxMinutes: 8,
      callbackToken: 'wake-token',
      reservationId: 'res-1',
      twilioCallSid: `CA${'a'.repeat(32)}`,
    });
    const placed = dialer.placeCall.mock.calls[0]?.[0] as {
      twiml: string;
      timeLimitSeconds: number;
    };
    expect(placed.twiml).toContain('an AI assistant calling on behalf of Baldvin');
    expect(placed.twiml).toContain('url="wss://agent.example.run.app/voice/stream"');
    const token = /name="token" value="([0-9a-f]+)"/.exec(placed.twiml)?.[1] ?? '';
    expect(sha(token)).toBe(session?.streamTokenHash);
    expect(placed.timeLimitSeconds).toBe(8 * 60 + 20);
  });

  it('refuses a second concurrent call and enforces the daily cap', async () => {
    const calls = memoryCalls();
    const dialer = fakeDialer();
    await startCall(dialDeps(calls, dialer), toolInput());
    await expect(
      startCall(dialDeps(calls, dialer), toolInput('44444444-4444-4444-8444-444444444444')),
    ).rejects.toThrow('still in progress');
    for (const row of calls.rows.values()) row.status = 'completed';
    await startCall(dialDeps(calls, dialer), toolInput('55555555-5555-4555-8555-555555555555'));
    for (const row of calls.rows.values()) row.status = 'completed';
    await startCall(dialDeps(calls, dialer), toolInput('66666666-6666-4666-8666-666666666666'));
    for (const row of calls.rows.values()) row.status = 'completed';
    await expect(
      startCall(dialDeps(calls, dialer), toolInput('77777777-7777-4777-8777-777777777777')),
    ).rejects.toThrow('daily limit');
  });

  it('releases the hold and marks the call failed when Twilio refuses it', async () => {
    const calls = memoryCalls();
    const dialer = fakeDialer();
    dialer.placeCall.mockRejectedValueOnce(new Error('twilio call failed: 21215 geo permission'));
    await expect(startCall(dialDeps(calls, dialer), toolInput())).rejects.toThrow('21215');
    expect(core.releaseReservation).toHaveBeenCalledWith({}, 'res-1');
    expect(calls.rows.get('11111111-1111-4111-8111-111111111111')?.status).toBe('failed');
  });

  it('builds the media stream URL from the public URL', () => {
    expect(mediaStreamUrl('https://a.run.app')).toBe('wss://a.run.app/voice/stream');
    expect(mediaStreamUrl('http://localhost:8787')).toBe('ws://localhost:8787/voice/stream');
  });
});

describe('call status webhook', () => {
  it('finishes an unanswered call and wakes the task, once', async () => {
    const calls = memoryCalls();
    await startCall(dialDeps(calls, fakeDialer()), toolInput());
    const deps = {
      calls,
      costs: {} as never,
      jobs: {} as never,
      notifyOwner: vi.fn(async () => {}),
    };
    const sid = `CA${'a'.repeat(32)}`;
    await handleCallStatus(deps, { CallSid: sid, CallStatus: 'ringing' });
    expect(calls.rows.get('11111111-1111-4111-8111-111111111111')?.status).toBe('ringing');
    await handleCallStatus(deps, { CallSid: sid, CallStatus: 'no-answer', CallDuration: '0' });
    await handleCallStatus(deps, { CallSid: sid, CallStatus: 'no-answer', CallDuration: '0' });
    expect(core.recordCallResult).toHaveBeenCalledTimes(1);
    expect(core.recordCallResult).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        token: 'wake-token',
        result: expect.objectContaining({ outcome: 'no_answer', summary: 'Nopa did not answer.' }),
      }),
    );
  });

  it('records the answering-machine verdict and ignores unknown calls', async () => {
    const calls = memoryCalls();
    await startCall(dialDeps(calls, fakeDialer()), toolInput());
    const deps = {
      calls,
      costs: {} as never,
      jobs: {} as never,
      notifyOwner: vi.fn(async () => {}),
    };
    await handleCallStatus(deps, { CallSid: `CA${'a'.repeat(32)}`, AnsweredBy: 'human' });
    expect(calls.rows.get('11111111-1111-4111-8111-111111111111')?.answeredBy).toBe('human');
    expect(
      (await handleCallStatus(deps, { CallSid: `CA${'b'.repeat(32)}`, CallStatus: 'completed' }))
        .status,
    ).toBe(200);
  });
});

type Listener = (...args: unknown[]) => void;

function fakeSocket() {
  const listeners = new Map<string, Listener[]>();
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    closed: false,
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close() {
      this.closed = true;
    },
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? [])
        listener(payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)));
    },
  };
}

function fakeVoice(connectGate?: Promise<void>) {
  let events: RealtimeSessionEvents | undefined;
  let config: RealtimeSessionConfig | undefined;
  const session = {
    sendAudio: vi.fn(),
    sendToolResult: vi.fn(),
    respond: vi.fn(),
    interrupt: vi.fn(),
    usage: () => ({
      inputAudioTokens: 1_000,
      inputTextTokens: 2_000,
      cachedInputTokens: 0,
      outputAudioTokens: 500,
      outputTextTokens: 100,
    }),
    close: vi.fn(async () => {}),
  } satisfies RealtimeSession;
  const resolved: ResolvedVoiceModel = {
    model: 'gpt-realtime-2.1',
    rates,
    provider: {
      kind: 'openai',
      connect: async (c, e) => {
        config = c;
        events = e;
        if (connectGate) await connectGate;
        return session;
      },
    },
  };
  return { resolved, session, events: () => events as RealtimeSessionEvents, config: () => config };
}

async function connectedBridge(
  options: { connectGate?: Promise<void>; openingWaitMs?: number } = {},
) {
  const calls = memoryCalls();
  const dialer = fakeDialer();
  const placed = await startCall(dialDeps(calls, dialer), toolInput());
  const twiml = (dialer.placeCall.mock.calls[0]?.[0] as { twiml: string } | undefined)?.twiml ?? '';
  const token = /name="token" value="([0-9a-f]+)"/.exec(twiml)?.[1] ?? '';
  const voice = fakeVoice(options.connectGate);
  const socket = fakeSocket();
  const notifyOwner = vi.fn(async (_input: { text: string; taskId?: string }) => {});
  handleMediaStream(socket as unknown as MediaSocket, {
    calls,
    costs: {} as never,
    jobs: {} as never,
    dialer,
    resolveVoice: async () => voice.resolved,
    notifyOwner,
    callUrl: (id) => `https://bot.example/calls/${id}`,
    ownerName: 'Baldvin',
    assistantName: 'Aria',
    timezone: 'America/Los_Angeles',
    pollMs: 20,
    checkinWaitMs: 2_000,
    openingWaitMs: options.openingWaitMs ?? 5_000,
  });
  return { calls, dialer, voice, socket, notifyOwner, token, placed };
}

const CALL_ID = '11111111-1111-4111-8111-111111111111';

describe('live call bridge', () => {
  it('refuses a stream whose token does not redeem', async () => {
    const { socket } = await connectedBridge();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token: 'forged' } },
    });
    await vi.waitFor(() => expect(socket.closed).toBe(true));
  });

  it('passes an opening screening prompt through after the voice model connects', async () => {
    let connect = () => {};
    const connectGate = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const { voice, socket, token } = await connectedBridge({ connectGate });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([1, 2]).toString('base64') },
    });
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([3, 4]).toString('base64') },
    });
    expect(voice.session.sendAudio).not.toHaveBeenCalled();
    connect();
    await vi.waitFor(() => expect(voice.session.sendAudio).toHaveBeenCalledTimes(2));
    expect(voice.session.sendAudio).toHaveBeenNthCalledWith(1, Uint8Array.of(1, 2));
    expect(voice.session.sendAudio).toHaveBeenNthCalledWith(2, Uint8Array.of(3, 4));
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('bounds caller audio while the voice model connects', async () => {
    let connect = () => {};
    const connectGate = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const { voice, socket, token } = await connectedBridge({ connectGate });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.alloc(100_000, 1).toString('base64') },
    });
    connect();
    await vi.waitFor(() => expect(voice.session.sendAudio).toHaveBeenCalledTimes(1));
    expect(voice.session.sendAudio.mock.calls[0]?.[0]).toHaveLength(80_000);
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('finishes a call that disconnects before its session is claimed', async () => {
    const { calls, voice, socket, token } = await connectedBridge();
    let releaseClaim = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const originalClaim = calls.claimStream.bind(calls);
    vi.spyOn(calls, 'claimStream').mockImplementation(async (id, hash, at) => {
      await claimGate;
      return originalClaim(id, hash, at);
    });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    socket.emit('close');
    releaseClaim();
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
    expect(calls.rows.get(CALL_ID)?.status).toBe('completed');
    expect(voice.config()).toBeUndefined();
  });

  it('closes a voice model that connects after the phone disconnects', async () => {
    let connect = () => {};
    const connectGate = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const { voice, socket, token } = await connectedBridge({ connectGate });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([1, 2]).toString('base64') },
    });
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
    connect();
    await vi.waitFor(() => expect(voice.session.close).toHaveBeenCalledTimes(1));
    expect(voice.session.sendAudio).not.toHaveBeenCalled();
    expect(voice.session.respond).not.toHaveBeenCalled();
  });

  it('introduces the call when the line stays quiet', async () => {
    const { voice, socket, token } = await connectedBridge({ openingWaitMs: 50 });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    await vi.waitFor(() =>
      expect(voice.session.respond).toHaveBeenCalledWith(
        expect.stringContaining('introduce yourself'),
      ),
    );
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('does not interrupt a caller with the quiet-line introduction', async () => {
    const { voice, socket, token } = await connectedBridge({ openingWaitMs: 50 });
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    voice.events().transcript('caller', 'Hello?');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(voice.session.respond).not.toHaveBeenCalled();
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled());
  });

  it('runs a call: brief-only instructions, screened audio, barge-in, check-in and wake', async () => {
    const { calls, dialer, voice, socket, notifyOwner, token } = await connectedBridge();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    expect(calls.rows.get(CALL_ID)?.status).toBe('in_progress');
    const instructions = voice.config()?.instructions ?? '';
    expect(instructions).toContain('GOAL: Book a table for two at 7:30pm tonight.');
    expect(instructions).toContain('NEVER: Pay a deposit.');
    expect(instructions).toContain('Never claim or imply that you are human');
    expect(voice.config()?.tools.map((tool) => tool.name)).toEqual([
      'ask_owner',
      'press_keys',
      'note',
      'end_call',
    ]);

    // Caller audio reaches the model before answering-machine detection finishes.
    socket.emit('message', {
      event: 'media',
      media: { payload: Buffer.from([1, 2]).toString('base64') },
    });
    expect(voice.session.sendAudio).toHaveBeenCalledWith(Uint8Array.of(1, 2));
    const get = vi.spyOn(calls, 'get');
    get.mockClear();
    await calls.update(CALL_ID, { answeredBy: 'machine_end_beep' });
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(CALL_ID));
    expect(dialer.hangup).not.toHaveBeenCalled();

    // Model speech goes out as 20 ms frames; the caller talking over it clears the line.
    voice.events().audio(new Uint8Array(320));
    expect(socket.sent.filter((m) => m.event === 'media')).toHaveLength(2);
    voice.events().speechStarted();
    expect(socket.sent.at(-1)).toEqual({ event: 'clear', streamSid: 'MZ1' });
    expect(voice.session.interrupt).toHaveBeenCalled();

    voice.events().transcript('caller', 'We have 7:45, is that OK?');
    voice.events().toolCall({ id: 'c1', name: 'note', args: { fact: 'Offered 7:45pm' } });
    voice.events().toolCall({ id: 'c2', name: 'ask_owner', args: { question: 'Is 7:45 OK?' } });
    await vi.waitFor(() => expect(notifyOwner).toHaveBeenCalled());
    expect(notifyOwner.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining(`https://bot.example/calls/${CALL_ID}`),
    });
    const checkin = ((calls.rows.get(CALL_ID)?.checkins ?? []) as CallCheckin[])[0] as CallCheckin;
    expect(await calls.answerCheckin('agent-1', CALL_ID, checkin.id, 'Yes', 'web')).toBe(true);
    await vi.waitFor(() =>
      expect(voice.session.sendToolResult).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c2' }),
        { answer: 'Yes' },
      ),
    );

    voice.events().toolCall({
      id: 'c3',
      name: 'end_call',
      args: { outcome: 'achieved', summary: 'Booked for 7:45pm under Smarason.' },
    });
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalledWith(`CA${'a'.repeat(32)}`), {
      timeout: 3_000,
    });

    socket.emit('message', { event: 'stop' });
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalledTimes(1), {
      timeout: 3_000,
    });
    const woke = core.recordCallResult.mock.calls[0]?.[1] as unknown as {
      result: {
        outcome: string;
        summary: string;
        notes: string[];
        durationSeconds: number;
        transcript: unknown[];
      };
    };
    expect(woke.result).toMatchObject({
      outcome: 'achieved',
      summary: 'Booked for 7:45pm under Smarason.',
      notes: ['Offered 7:45pm'],
      durationSeconds: 95,
    });
    expect(woke.result.transcript).toContainEqual({
      role: 'them',
      text: 'We have 7:45, is that OK?',
    });
    // Line: 2 started minutes; model: priced from its reported usage.
    expect(core.reconcileReservation).toHaveBeenCalledWith(
      {},
      'res-1',
      expect.objectContaining({ usd: 2 * 0.014, quantity: 2 }),
    );
    expect(core.recordCostEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        source: 'model',
        usd: (1_000 * 32 + 2_000 * 4 + 500 * 64 + 100 * 24) / 1e6,
      }),
    );
    expect(calls.rows.get(CALL_ID)?.status).toBe('completed');
    expect(voice.session.close).toHaveBeenCalled();
  });

  it('lets the model distinguish voicemail from screening before hanging up', async () => {
    const { calls, dialer, voice, socket, token } = await connectedBridge();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    const get = vi.spyOn(calls, 'get');
    get.mockClear();
    await calls.update(CALL_ID, { answeredBy: 'machine_end_beep' });
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith(CALL_ID));
    expect(dialer.hangup).not.toHaveBeenCalled();
    voice.events().toolCall({
      id: 'voicemail',
      name: 'end_call',
      args: { outcome: 'voicemail', summary: 'Reached voicemail; no message was left.' },
    });
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalled());
    socket.emit('close');
    await vi.waitFor(() => expect(core.recordCallResult).toHaveBeenCalled(), { timeout: 3_000 });
    expect(core.recordCallResult.mock.calls[0]?.[1]).toMatchObject({
      result: { outcome: 'voicemail' },
    });
  });

  it('ends the call when the owner hangs up from the app', async () => {
    const { calls, dialer, voice, socket, token } = await connectedBridge();
    socket.emit('message', {
      event: 'start',
      start: { streamSid: 'MZ1', customParameters: { callId: CALL_ID, token } },
    });
    await vi.waitFor(() => expect(voice.config()).toBeDefined());
    expect(await calls.requestHangup('agent-1', CALL_ID)).toBe(true);
    await vi.waitFor(() => expect(dialer.hangup).toHaveBeenCalled());
  });
});
