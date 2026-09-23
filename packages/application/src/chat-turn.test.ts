import { loadConfig, resetConfigForTest } from '@assistant/config';
import { TRIAGED_ACTIONABLE } from '@assistant/core/events';
import type { ModelRouter } from '@assistant/core/model-router';
import type { ApplicationChatPersistence } from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The two busiest model calls in the product — the needs-action triage and the
// tool-less conversational reply — run inside handleChatTurn, before any task
// or plan exists, so the executor harnesses never reach them. These tests drive
// the real handler with a scripted router and an in-memory chat store; only
// the context reads and the queue are stubbed.

const stubs = vi.hoisted(() => ({
  enqueueTask: vi.fn(),
}));

vi.mock('@assistant/core/workflow/machine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core/workflow/machine')>()),
  enqueueTask: stubs.enqueueTask,
}));
vi.mock('@assistant/core/memory/commitments', () => ({
  listOpenCommitments: async () => [],
  renderOpenCommitments: () => '',
}));
vi.mock('@assistant/core/memory/ambient', () => ({ getAmbientBlock: async () => undefined }));
vi.mock('@assistant/core/memory/consolidation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant/core/memory/consolidation')>()),
  getOwnerCard: async () => undefined,
}));

const { handleChatTurn } = await import('./chat-turn.js');

const AGENT = '00000000-0000-4000-8000-00000000000a';
const CONVERSATION = '00000000-0000-4000-8000-00000000000c';

type Completion = {
  status: 'done' | 'failed';
  progress?: string;
  messages: Array<{ text: string; parts: unknown[] }>;
};

function chatStore() {
  const messages: Array<Record<string, unknown>> = [];
  const completions: Completion[] = [];
  let taskCount = 0;
  const chat = {
    kind: 'application-chat-persistence',
    resolveAgent: async () => ({
      id: AGENT,
      name: 'Assistant',
      email: 'assistant@example.com',
      timezone: 'UTC',
    }),
    getConversation: async () => ({
      id: CONVERSATION,
      agentId: AGENT,
      title: 'Existing chat',
      archivedAt: null,
      metadata: {},
      modelOverride: null,
    }),
    appendOwned: async (_agentId: string, input: Record<string, unknown>) => {
      const row = {
        id: `00000000-0000-4000-8000-${String(messages.length + 1).padStart(12, '0')}`,
        taskId: null,
        createdAt: new Date(Date.UTC(2026, 8, 23, 12, 0, messages.length)),
        ...input,
      };
      messages.push(row);
      return row;
    },
    listMessages: async () => ({ messages: [...messages], hasMore: false }),
    getTaskKinds: async () => new Map(),
    createDirectChatTask: async (input: { conversationId: string }) => ({
      id: `task-${++taskCount}`,
      conversationId: input.conversationId,
    }),
    completeDirectChatTask: async (input: Completion) => {
      completions.push(input);
      return true;
    },
    listConversationEvidence: async () => [],
  };
  return { chat: chat as unknown as ApplicationChatPersistence, completions };
}

type RouterScript = {
  triage?: { needsAction: boolean } | Error;
  draft?: string;
  budgetBlocked?: boolean;
};

function scriptedRouter(script: RouterScript) {
  const object = vi.fn(async () => {
    if (script.triage instanceof Error) throw script.triage;
    return { ok: true, object: script.triage ?? { needsAction: false } };
  });
  const stream = vi.fn(
    async (_role: string, options: { onComplete: (text: string) => Promise<void> }) => {
      if (script.budgetBlocked)
        return { ok: false, decision: { mode: 'block', reason: 'daily cap reached' } };
      const draft = script.draft ?? '';
      await options.onComplete(draft);
      const chunks = [
        { type: 'start' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: draft },
        { type: 'text-end', id: 't' },
      ];
      return {
        ok: true,
        modelId: 'test/model',
        degraded: false,
        text: Promise.resolve(draft),
        toUIMessageStream: () =>
          (async function* () {
            yield* chunks;
          })(),
      };
    },
  );
  return { router: { object, stream } as unknown as ModelRouter, object, stream };
}

function send(text: string, extra: Record<string, unknown> = {}) {
  return new Request('https://assistant.example/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: CONVERSATION,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text }] }],
      ...extra,
    }),
  });
}

function config() {
  return loadConfig({
    OPENROUTER_API_KEY: 'test-key',
    QUEUE_DRIVER: 'local',
    CHAT_RECALL_ENABLED: 'false',
    GRAPH_RAG_ENABLED: 'false',
  });
}

beforeEach(() => {
  stubs.enqueueTask.mockReset();
  stubs.enqueueTask.mockResolvedValue({ task: { id: 'queued-task' } });
});
afterEach(() => resetConfigForTest());

async function turn(text: string, script: RouterScript, extra: Record<string, unknown> = {}) {
  const store = chatStore();
  const scripted = scriptedRouter(script);
  const response = await handleChatTurn(send(text, extra), {
    config: config(),
    router: scripted.router,
    chat: store.chat,
    persistence: { tasks: {}, ownerContext: {} } as never,
  });
  return { response, ...store, ...scripted };
}

function queuedPayload() {
  const [[, input]] = stubs.enqueueTask.mock.calls as unknown as [
    [unknown, { event: { payload: Record<string, unknown> } }],
  ];
  return input.event.payload;
}

describe('chat needs-action triage', () => {
  it('sends a clear live lookup to the executor without asking the classifier', async () => {
    const { response, object, stream } = await turn(
      "What's the Giants score and the drive time to Oracle Park?",
      {},
    );
    expect(response.headers.get('x-async-task')).toBe('queued-task');
    expect(object).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBe(true);
  });

  it('routes to the executor when the classifier rules the turn actionable', async () => {
    const { response, object, stream } = await turn('Could you sort out the thing from earlier', {
      triage: { needsAction: true },
    });
    expect(object).toHaveBeenCalledOnce();
    expect(response.headers.get('x-async-task')).toBe('queued-task');
    expect(stream).not.toHaveBeenCalled();
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBe(true);
  });

  it('defaults to the executor when the classifier fails, without claiming a ruling', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { response, stream } = await turn('Could you sort out the thing from earlier', {
      triage: new Error('classifier timed out'),
    });
    quiet.mockRestore();
    expect(response.headers.get('x-async-task')).toBe('queued-task');
    expect(stream).not.toHaveBeenCalled();
    expect(queuedPayload()[TRIAGED_ACTIONABLE]).toBeUndefined();
  });

  it('asks the classifier about the latest message, labelled as the one to classify', async () => {
    const { object } = await turn('tell me a joke about otters', {
      triage: { needsAction: false },
      draft: 'Why did the otter cross the river? To get to the other slide.',
    });
    const [, request] = object.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(request.prompt).toMatch(/LATEST USER MESSAGE \(classify this\):\ntell me a joke/);
  });
});

describe('tool-less conversational reply', () => {
  it('streams the draft and persists exactly the text it streamed', async () => {
    const draft = 'Otters hold hands while they sleep so they do not drift apart.';
    const { response, completions, stream, object } = await turn('tell me an otter fact', {
      triage: { needsAction: false },
      draft,
    });
    expect(object).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    expect(stubs.enqueueTask).not.toHaveBeenCalled();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.status).toBe('done');
    expect(completions[0]?.messages[0]?.text).toBe(draft);
    const body = await response.text();
    expect(body).toContain(JSON.stringify(draft).slice(1, -1));
    expect(body).not.toContain('data-off-course');
  });

  it('records an empty completion as a failed turn, not a blank bubble', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { completions } = await turn('tell me an otter fact', {
      triage: { needsAction: false },
      draft: '   ',
    });
    quiet.mockRestore();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.status).toBe('failed');
    expect(completions[0]?.messages.map((message) => message.text)).toEqual([
      'The model returned an empty reply. Trying again usually works.',
    ]);
  });

  it('replaces a draft that claims work it never did, in the log and the stream alike', async () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const draft =
      'I checked your primary calendar and the shared "Family" calendar — no flights in the next 3 weeks.';
    const { response, completions } = await turn('any flights coming up, do you think', {
      triage: { needsAction: false },
      draft,
    });
    quiet.mockRestore();
    const persisted = completions[0]?.messages[0]?.text;
    expect(persisted).toBeDefined();
    expect(persisted).not.toBe(draft);
    const body = await response.text();
    expect(body).toContain('data-off-course');
    // retireProvisionalReplies matches on exact text, so the marker must carry
    // the persisted replacement byte for byte.
    expect(body).toContain(JSON.stringify(persisted).slice(1, -1));
  });

  it('reports a spending-cap block with a 402 and a durable failure notice', async () => {
    const { response, completions } = await turn('tell me an otter fact', {
      triage: { needsAction: false },
      budgetBlocked: true,
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: 'budget_exhausted' });
    expect(completions[0]?.status).toBe('failed');
    expect(completions[0]?.messages[0]?.text).toMatch(/spending cap/);
  });
});
