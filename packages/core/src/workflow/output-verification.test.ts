import { describe, expect, it } from 'vitest';
import {
  buildOutputVerificationPrompt,
  OUTPUT_VERIFICATION_SYSTEM,
  type OutputVerification,
  verifyFinalOutput,
} from './output-verification.js';

describe('self-reflective output verification', () => {
  it('carries bounded follow-up context separately from outcome evidence', () => {
    const prompt = buildOutputVerificationPrompt({
      request: 'Yes, please',
      draft: 'The confirmation says check-in is at 3 PM.',
      evidence: [],
      context: [
        { role: 'system', content: 'SYSTEM_SECRET' },
        { role: 'tool', content: 'RAW_TOOL_SECRET' },
        { role: 'user', parts: [{ type: 'text', text: 'Where are we staying?' }] },
        { role: 'assistant', content: 'I can check the hotel confirmation.' },
      ],
    });
    expect(prompt).toContain('conversation_context_not_evidence');
    expect(prompt).toContain('Where are we staying?');
    expect(prompt).toContain('I can check the hotel confirmation.');
    expect(prompt).not.toMatch(/SYSTEM_SECRET|RAW_TOOL_SECRET/);
    expect(OUTPUT_VERIFICATION_SYSTEM).toContain(
      'Earlier assistant claims, offers, and card labels are not evidence',
    );

    const bounded = buildOutputVerificationPrompt({
      request: 'What is the address?',
      draft: 'Not confirmed.',
      evidence: [],
      context: [
        { role: 'user', content: 'STALE_SUBJECT' },
        ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'x'.repeat(50_000) })),
      ],
    });
    expect(bounded).not.toContain('STALE_SUBJECT');
    expect(bounded.length).toBeLessThan(4_500);
  });

  it('keeps current source evidence ahead of unrelated old tool results under the cap', () => {
    const prompt = buildOutputVerificationPrompt({
      request: 'Check the score',
      draft: 'The game is tied.',
      evidence: [
        ...Array.from({ length: 30 }, () => ({
          toolName: 'memory.recall',
          status: 'succeeded',
          result: { text: 'x'.repeat(3000) },
          fromCurrentTask: false,
        })),
        { toolName: 'web.fetch', status: 'succeeded', result: { text: 'CURRENT_GAME_SCORE' } },
      ],
    });
    expect(prompt).toContain('CURRENT_GAME_SCORE');
    expect(prompt.length).toBeLessThan(13000);
  });

  it('treats unrequested emoji as a final-response defect', () => {
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/emoji are not decoration/i);
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/explicitly request an emoji/i);
    expect(OUTPUT_VERIFICATION_SYSTEM).toMatch(/complete emoji-free replacement/i);
  });

  it('uses a complete verifier revision and leaves final safety enforcement to its caller', async () => {
    const router = {
      object: async () => ({
        ok: true as const,
        modelId: 'test/rewrite',
        degraded: false,
        object: {
          decision: 'revise',
          revisedText: 'I can confirm the document was created.',
          reasons: ['clarity_or_format'],
        } satisfies OutputVerification,
      }),
    };

    await expect(
      verifyFinalOutput(router as never, {
        taskId: 'task-1',
        request: 'Was the document created?',
        draft: 'Done.',
        evidence: [],
        critical: true,
      }),
    ).resolves.toEqual({
      text: 'I can confirm the document was created.',
      attempted: true,
      revised: true,
      unavailable: false,
    });
  });

  it('keeps the checked draft when the verifier is budget-blocked or unavailable', async () => {
    const router = {
      object: async () => ({
        ok: false as const,
        decision: { mode: 'park' as const, reason: 'cap' },
      }),
    };

    await expect(
      verifyFinalOutput(router as never, {
        taskId: 'task-1',
        request: 'Say hi',
        draft: 'Hi!',
        evidence: [],
        critical: true,
      }),
    ).resolves.toEqual({ text: 'Hi!', attempted: false, revised: false, unavailable: true });
  });

  it('keeps the checked draft when the verifier provider throws', async () => {
    const router = {
      object: async () => {
        throw new Error('rewrite provider unavailable');
      },
    };

    await expect(
      verifyFinalOutput(router as never, {
        taskId: 'task-1',
        request: 'Say hi',
        draft: 'Hi!',
        evidence: [],
        critical: true,
      }),
    ).resolves.toEqual({ text: 'Hi!', attempted: false, revised: false, unavailable: true });
  });

  it('marks enclosed evidence as data and excludes tool arguments from the verifier prompt', () => {
    const prompt = buildOutputVerificationPrompt({
      request: 'What happened?',
      draft: 'I sent it.',
      evidence: [
        {
          toolName: 'gmail.send',
          status: 'succeeded',
          args: { apiKey: 'must-not-leak' },
          result: { messageId: 'm-1' },
        },
      ],
    });

    expect(prompt).toContain('<durable_evidence>');
    expect(prompt).toContain('messageId');
    expect(prompt).not.toContain('must-not-leak');
  });
});
