import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FirestoreCallSessionRepository } from './call-sessions.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Firestore call sessions', () => {
  let store: InstallationStore;
  let calls: FirestoreCallSessionRepository;
  const agentId = randomUUID();

  beforeEach(() => {
    store = emulatorStore();
    calls = new FirestoreCallSessionRepository(store, agentId);
  });

  afterEach(async () => disposeStore(store));

  const create = (id = randomUUID()) =>
    calls.create({
      id,
      agentId,
      taskId: randomUUID(),
      toolCallId: randomUUID(),
      status: 'dialing',
      to: '+14155550123',
      contactName: 'Nopa',
      brief: { goal: 'Book a table' },
      voiceModel: 'openai:gpt-realtime-2.1',
      maxMinutes: 10,
      streamTokenHash: 'hash-1',
      callbackToken: 'wake',
      reservationId: 'res',
    });

  it('redeems the stream token once and marks the call connected', async () => {
    const call = await create();
    expect(await calls.claimStream(call.id, 'wrong', new Date())).toBeNull();
    const claimed = await calls.claimStream(call.id, 'hash-1', new Date());
    expect(claimed).toMatchObject({ status: 'in_progress', streamTokenHash: null });
    expect(claimed?.startedAt).toBeInstanceOf(Date);
    expect(await calls.claimStream(call.id, 'hash-1', new Date())).toBeNull();
    expect(await calls.activeCount(agentId)).toBe(1);
  });

  it('finishes a call exactly once and stops counting it as active', async () => {
    const call = await create();
    expect(await calls.finish(call.id, { status: 'completed', outcome: 'achieved' })).toMatchObject(
      {
        status: 'completed',
      },
    );
    expect(await calls.finish(call.id, { status: 'failed' })).toBeNull();
    expect((await calls.get(call.id))?.status).toBe('completed');
    expect(await calls.activeCount(agentId)).toBe(0);
    expect(await calls.countSince(agentId, new Date(Date.now() - 60_000))).toBe(1);
    expect(await calls.requestHangup(agentId, call.id)).toBe(false);
  });

  it('keeps transcript, notes and one answer per check-in, scoped to the owner', async () => {
    const call = await create();
    await calls.update(call.id, { twilioCallSid: `CA${'c'.repeat(32)}` });
    expect((await calls.getByCallSid(`CA${'c'.repeat(32)}`))?.id).toBe(call.id);
    await calls.appendTranscript(call.id, [{ role: 'caller', text: 'Hello?', at: 't1' }]);
    await calls.appendTranscript(call.id, [{ role: 'assistant', text: 'Hi!', at: 't2' }]);
    await calls.appendNote(call.id, 'Opens at 5pm');
    await calls.addCheckin(call.id, {
      id: 'q1',
      question: '7:45?',
      askedAt: 't3',
      answer: null,
      answeredAt: null,
      via: null,
    });
    expect(await calls.answerCheckin(randomUUID(), call.id, 'q1', 'no', 'web')).toBe(false);
    expect(await calls.answerCheckin(agentId, call.id, 'q1', 'Yes', 'mobile')).toBe(true);
    expect(await calls.answerCheckin(agentId, call.id, 'q1', 'No', 'web')).toBe(false);
    const row = await calls.get(call.id);
    expect(row?.transcript).toEqual([
      { role: 'caller', text: 'Hello?', at: 't1' },
      { role: 'assistant', text: 'Hi!', at: 't2' },
    ]);
    expect(row?.notes).toEqual(['Opens at 5pm']);
    expect(row?.checkins).toEqual([expect.objectContaining({ answer: 'Yes', via: 'mobile' })]);
    expect(await calls.requestHangup(agentId, call.id)).toBe(true);
    expect((await calls.list(agentId, 10)).map((c) => c.id)).toEqual([call.id]);
    expect(await new FirestoreCallSessionRepository(store, randomUUID()).get(call.id)).toBeNull();
  });
});
