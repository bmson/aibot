import { describe, expect, it } from 'vitest';
import { looksLikeActionRequest } from './chat-triage.js';

describe('looksLikeActionRequest', () => {
  it('catches clear action requests the weak classifier drops', () => {
    for (const t of [
      'add lunch Friday noon', // the reported prod miss
      'Add lunch friday',
      'please add lunch friday',
      'can you add this to my calendar',
      'could you please check my inbox',
      'remind me to call mom tomorrow',
      'schedule a meeting with Anna next week',
      'book a table for 2 on friday',
      'send an email to the team about the launch',
      'cancel my 3pm',
      'reschedule the dentist',
      'look up flights to Boston',
      'search for a birthday gift under $50',
      'put it on my calendar',
      'add milk to my shopping list',
      'unsubscribe me from that newsletter',
      'move my 3pm meeting to 4',
      'find me a good sushi place nearby',
    ]) {
      expect(looksLikeActionRequest(t), `should be an action: ${t}`).toBe(true);
    }
  });

  it('leaves plain conversation for the model to classify', () => {
    for (const t of [
      'what do you think about the plan?',
      'thanks, that helps!',
      'that makes sense',
      'how are you doing today?',
      'check this out',
      'I found that really funny',
      'who won the game last night?',
      'explain how embeddings work',
      'why did that happen?',
      'nice work on the summary',
      '',
      '   ',
    ]) {
      expect(looksLikeActionRequest(t), `should be conversation: ${t}`).toBe(false);
    }
  });
});
