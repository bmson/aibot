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

  it('catches calendar/inbox read requests', () => {
    for (const t of [
      'look at my calendar and tell me the flight schedule for the next 3 weeks', // the reported prod miss
      "what's on my calendar this week",
      'show me my inbox',
      'go through my email and flag anything urgent',
      'tell me my schedule for tomorrow',
      'review my calendar for conflicts next month',
      'pull up my appointments for Friday',
      'can you look at my calendar and tell me when I fly',
      'anything urgent in my inbox?',
      'what do I have planned this weekend',
      'What is happening on Monday?',
      'When is my Clay interview?',
    ]) {
      expect(looksLikeActionRequest(t), `should be an action: ${t}`).toBe(true);
    }
  });

  it('leaves plain conversation for the model to classify', () => {
    for (const t of [
      'what do you think about the plan?',
      'Why do interviews make me nervous?',
      'thanks, that helps!',
      'that makes sense',
      'how are you doing today?',
      'check this out',
      'I found that really funny',
      'who won the game last night?',
      'explain how embeddings work',
      'why did that happen?',
      'nice work on the summary',
      'I looked at my calendar yesterday and it was busy', // past-tense recap — classifier still sees it
      "let's look at the numbers",
      'show me how embeddings work',
      "what's on your mind?",
      'I read the email you drafted, looks good',
      '',
      '   ',
    ]) {
      expect(looksLikeActionRequest(t), `should be conversation: ${t}`).toBe(false);
    }
  });

  it('routes a failed-action follow-up back to the executor', () => {
    expect(
      looksLikeActionRequest(
        "I'm not seeing the change in these docs",
        "I'll update the contact info in both documents now.",
      ),
    ).toBe(true);
    expect(
      looksLikeActionRequest(
        'Those were not updated',
        'I updated both Google Docs with the new email address.',
      ),
    ).toBe(true);
  });

  it('routes calendar-verification follow-ups back to the executor', () => {
    expect(
      looksLikeActionRequest(
        'Was that made up?',
        'I checked your calendar and found a Linear interview.',
      ),
    ).toBe(true);
    expect(
      looksLikeActionRequest("Are you sure? I don't see it on my calendar", 'It is on Monday.'),
    ).toBe(true);
  });

  it('does not infer an action from a complaint without a prior action commitment', () => {
    expect(looksLikeActionRequest("I'm not seeing the change", 'That makes sense.')).toBe(false);
  });

  it('routes a forecast the ambient block cannot answer to the executor', () => {
    for (const t of [
      'How will the weather be tomorrow?', // the reported prod miss: invented a forecast
      'How will the weather be in San Francisco', // and then apologised for having none
      "what's the forecast for Tokyo this week",
      'will it rain in Boston tomorrow?',
      'is it going to snow this weekend?',
      'what is the temperature in Reykjavík?',
    ]) {
      expect(looksLikeActionRequest(t), `should be a lookup: ${t}`).toBe(true);
    }
  });

  it('leaves right-here-right-now weather to the ambient block', () => {
    for (const t of [
      "what's the weather?",
      'how is the weather right now',
      'is it raining?',
      'ugh, rain all weekend',
      'I love the rain on a Sunday',
    ]) {
      expect(looksLikeActionRequest(t), `should be conversation: ${t}`).toBe(false);
    }
  });
});
