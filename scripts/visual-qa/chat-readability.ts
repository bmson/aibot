import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '@assistant/config';
import { ModelRouter } from '@assistant/core/model-router';
import { agents, conversations, createDb, messages } from '@assistant/db';
import { and, eq } from 'drizzle-orm';

type RunName = 'baseline' | 'reframed';

interface PromptCorpus {
  baselineFraming: string;
  reviewFraming: string;
  prompts: string[];
}

interface GeneratedRun {
  run: RunName;
  framing: string;
  modelId: string;
  responses: Array<{ index: number; prompt: string; response: string }>;
}

interface RunState {
  conversationId: string;
}

const repoRoot = path.resolve(import.meta.dirname, '../..');
const artifactDir = path.join(repoRoot, '.artifacts/chat-readability');
const corpusPath = path.join(import.meta.dirname, 'chat-readability-prompts.json');
const modelOverride = 'qwen/qwen3-30b-a3b-instruct-2507';

function runName(value: string | undefined): RunName {
  if (value === 'baseline' || value === 'reframed') return value;
  throw new Error('run must be baseline or reframed');
}

async function corpus(): Promise<PromptCorpus> {
  return JSON.parse(await readFile(corpusPath, 'utf8')) as PromptCorpus;
}

function generatedPath(run: RunName): string {
  return path.join(artifactDir, `${run}-responses.json`);
}

function statePath(run: RunName): string {
  return path.join(artifactDir, `${run}-state.json`);
}

async function generate(run: RunName): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const router = new ModelRouter(db, config.OPENROUTER_API_KEY);
  const input = await corpus();
  if (input.prompts.length !== 30)
    throw new Error(`expected 30 prompts, found ${input.prompts.length}`);
  const framing = run === 'baseline' ? input.baselineFraming : input.reviewFraming;
  const responses: GeneratedRun['responses'] = [];

  for (let offset = 0; offset < input.prompts.length; offset += 5) {
    const batch = input.prompts.slice(offset, offset + 5);
    const generated = await Promise.all(
      batch.map(async (prompt, batchIndex) => {
        const index = offset + batchIndex + 1;
        const result = await router.generate('batch', {
          modelOverride,
          system:
            run === 'baseline'
              ? 'You are a helpful AI assistant. Respond to the user request directly. Preserve any structure the request asks for.'
              : `You are a helpful AI assistant. ${framing} Do not mention these formatting instructions.`,
          prompt,
          temperature: 0.35,
          maxOutputTokens: 700,
          critical: true,
        });
        if (!result.ok) throw new Error(`model budget blocked prompt ${index}`);
        return { index, prompt, response: result.text.trim(), modelId: result.modelId };
      }),
    );
    responses.push(...generated.map(({ modelId: _modelId, ...item }) => item));
    console.log(
      `generated ${Math.min(offset + batch.length, input.prompts.length)}/${input.prompts.length}`,
    );
  }

  const output: GeneratedRun = { run, framing, modelId: modelOverride, responses };
  await writeFile(generatedPath(run), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

async function ensureConversation(run: RunName): Promise<RunState> {
  try {
    return JSON.parse(await readFile(statePath(run), 'utf8')) as RunState;
  } catch {
    const config = loadConfig();
    const db = createDb(config.DATABASE_URL);
    const [agent] = await db.select({ id: agents.id }).from(agents).limit(1);
    if (!agent) throw new Error('assistant agent row is missing');
    const [conversation] = await db
      .insert(conversations)
      .values({
        agentId: agent.id,
        channel: 'chat',
        trust: 'owner',
        title: `Readability QA — ${run}`,
        metadata: { visualQA: true, run },
      })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('failed to create QA conversation');
    const state = { conversationId: conversation.id };
    await writeFile(statePath(run), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }
}

async function append(run: RunName, index: number): Promise<void> {
  const generated = JSON.parse(await readFile(generatedPath(run), 'utf8')) as GeneratedRun;
  const item = generated.responses.find((response) => response.index === index);
  if (!item) throw new Error(`response ${index} is missing`);
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  const state = await ensureConversation(run);
  const runKey = state.conversationId.slice(0, 8);
  const userKey = `readability-${run}-${runKey}-user-${index.toString().padStart(2, '0')}`;
  const [existing] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, state.conversationId),
        eq(messages.channelMessageId, userKey),
      ),
    )
    .limit(1);
  if (existing) return;

  const createdAt = new Date(Date.now() + index * 2_000);
  await db.insert(messages).values([
    {
      conversationId: state.conversationId,
      role: 'user',
      parts: [{ type: 'text', text: item.prompt }],
      text: item.prompt,
      origin: 'owner',
      channelMessageId: userKey,
      createdAt,
    },
    {
      conversationId: state.conversationId,
      role: 'assistant',
      parts: [{ type: 'text', text: item.response }],
      text: item.response,
      origin: 'assistant',
      channelMessageId: `readability-${run}-${runKey}-assistant-${index.toString().padStart(2, '0')}`,
      createdAt: new Date(createdAt.getTime() + 1_000),
    },
  ]);
}

async function main(): Promise<void> {
  const [command, rawRun, rawIndex] = process.argv.slice(2);
  const run = runName(rawRun);
  if (command === 'generate') return generate(run);
  if (command === 'append') {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 1 || index > 30) throw new Error('index must be 1-30');
    return append(run, index);
  }
  if (command === 'url') {
    const state = await ensureConversation(run);
    console.log(`http://localhost:3000/chat/${state.conversationId}`);
    return;
  }
  if (command === 'stage') {
    const start = Number(rawIndex ?? 1);
    for (let index = start; index <= 30; index += 1) {
      await append(run, index);
      const ready = path.join(artifactDir, `${run}-ready-${index.toString().padStart(2, '0')}`);
      const captured = path.join(
        artifactDir,
        `${run}-captured-${index.toString().padStart(2, '0')}`,
      );
      await writeFile(ready, '', 'utf8');
      while (true) {
        try {
          await access(captured);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    return;
  }
  throw new Error('usage: chat-readability.ts generate|append|url|stage baseline|reframed [index]');
}

await main();
// createDb owns a pooled postgres client that intentionally keeps long-running
// services alive. This is a one-shot QA utility, so exit after all awaited
// writes have completed instead of leaving the shell attached to the pool.
process.exit(0);
