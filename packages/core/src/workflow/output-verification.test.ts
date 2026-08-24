import { describe, expect, it } from 'vitest';
import {
  buildOutputVerificationPrompt,
  type OutputVerification,
  verifyFinalOutput,
} from './output-verification.js';

describe('self-reflective output verification', () => {
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
