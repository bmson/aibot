import { getAgent } from '@assistant/core';
import { conversations, createDb, type Db, watches } from '@assistant/db';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractWebText } from './builtin/index.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';
import { registerWatchTools } from './watches.js';
import { describeWebWatch, webWatchMatchSchema, webWatchOutcome } from './web-watches.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';

describe('webWatchMatchSchema', () => {
  it('defaults mode to change and validates the url', () => {
    const parsed = webWatchMatchSchema.parse({ url: 'https://a.example/p' });
    expect(parsed.mode).toBe('change');
    expect(webWatchMatchSchema.safeParse({ url: 'not a url' }).success).toBe(false);
  });

  it('requires a pattern for contains/absent but not for change', () => {
    expect(
      webWatchMatchSchema.safeParse({ url: 'https://a.example', mode: 'contains' }).success,
    ).toBe(false);
    expect(
      webWatchMatchSchema.safeParse({ url: 'https://a.example', mode: 'contains', pattern: 'x' })
        .success,
    ).toBe(true);
    expect(
      webWatchMatchSchema.safeParse({ url: 'https://a.example', mode: 'change' }).success,
    ).toBe(true);
  });
});

describe('webWatchOutcome — change', () => {
  const match = webWatchMatchSchema.parse({ url: 'https://a.example', mode: 'change' });

  it('records a baseline on first sight and does not fire', () => {
    const outcome = webWatchOutcome(match, 'hello world', {});
    expect(outcome.triggered).toBe(false);
    expect(outcome.nextState.fingerprint).toBeTruthy();
  });

  it('fires on a real change and never re-fires the same content', () => {
    const base = webWatchOutcome(match, 'v1', {});
    expect(webWatchOutcome(match, 'v1', base.nextState).triggered).toBe(false);
    const changed = webWatchOutcome(match, 'v2', base.nextState);
    expect(changed.triggered).toBe(true);
    expect(webWatchOutcome(match, 'v2', changed.nextState).triggered).toBe(false);
  });
});

describe('webWatchOutcome — contains/absent are edge-triggered from a baseline', () => {
  it('contains fires only on the absent → present transition', () => {
    const m = webWatchMatchSchema.parse({
      url: 'https://a.example',
      mode: 'contains',
      pattern: 'In stock',
    });
    const base = webWatchOutcome(m, 'Sold out', {});
    expect(base.triggered).toBe(false);
    expect(base.nextState.present).toBe(false);
    const appears = webWatchOutcome(m, 'It is now In Stock!', base.nextState);
    expect(appears.triggered).toBe(true);
    expect(webWatchOutcome(m, 'still in stock', appears.nextState).triggered).toBe(false);
  });

  it('absent fires only on the present → absent transition', () => {
    const m = webWatchMatchSchema.parse({
      url: 'https://a.example',
      mode: 'absent',
      pattern: 'maintenance',
    });
    const base = webWatchOutcome(m, 'under maintenance', {});
    expect(base.triggered).toBe(false);
    expect(webWatchOutcome(m, 'all systems go', base.nextState).triggered).toBe(true);
  });
});

describe('extractWebText', () => {
  it('strips scripts/styles/tags and collapses whitespace for html', () => {
    const html =
      '<html><head><style>.x{}</style><script>doEvil()</script></head><body>  Hello   <b>World</b> </body></html>';
    expect(extractWebText('text/html', html)).toBe('Hello World');
  });

  it('passes non-html bodies through unchanged', () => {
    expect(extractWebText('application/json', '{"a": 1}')).toBe('{"a": 1}');
  });
});

describe('describeWebWatch', () => {
  it('renders the mode and pattern', () => {
    expect(
      describeWebWatch(webWatchMatchSchema.parse({ url: 'https://a.example', mode: 'change' })),
    ).toContain('change');
    expect(
      describeWebWatch(
        webWatchMatchSchema.parse({ url: 'https://a.example', mode: 'contains', pattern: 'x' }),
      ),
    ).toContain('"x"');
  });
});

describe('watch.web tool', () => {
  let db: Db;
  let dbUp = false;
  let agentId: string;
  const registry = new ToolRegistry();
  registerWatchTools(registry);
  const tool = (name: string) => registry.get(name)?.tool;
  const createdConversationIds: string[] = [];

  // The dispatcher parses raw args through the tool's inputSchema (applying zod
  // defaults) before calling execute; mirror that so defaults like
  // expiresInDays/intervalMinutes are populated as they are in production.
  async function run(name: string, rawArgs: unknown) {
    const t = tool(name);
    if (!t) throw new Error(`${name} not registered`);
    return t.execute(t.inputSchema.parse(rawArgs), ctx());
  }

  function ctx(): ToolContext {
    return {
      taskId: 'task-x',
      agentId,
      trust: 'owner',
      tainted: false,
      db,
      now: () => new Date('2026-07-20T12:00:00.000Z'),
      signal: new AbortController().signal,
      log: async () => {},
    };
  }

  beforeAll(async () => {
    db = createDb(DATABASE_URL);
    try {
      agentId = (await getAgent(db)).id;
      dbUp = true;
    } catch {
      console.warn('web-watches.test: database unreachable — skipping');
    }
  });

  afterAll(async () => {
    if (!dbUp) return;
    const rows = await db
      .select({ id: watches.id })
      .from(watches)
      .where(like(watches.name, 'Xtest-Web-%'));
    if (rows.length) {
      await db.delete(watches).where(
        inArray(
          watches.id,
          rows.map((r) => r.id),
        ),
      );
    }
    if (createdConversationIds.length) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
  });

  it('rejects a sub-15-minute interval, a bad url, and a patternless contains', () => {
    const schema = tool('watch.web')?.inputSchema;
    if (!schema) throw new Error('watch.web not registered');
    expect(
      schema.safeParse({ name: 'x', url: 'https://a.example', intervalMinutes: 5 }).success,
    ).toBe(false);
    expect(schema.safeParse({ name: 'x', url: 'not a url' }).success).toBe(false);
    expect(
      schema.safeParse({ name: 'x', url: 'https://a.example', mode: 'contains' }).success,
    ).toBe(false);
    expect(schema.safeParse({ name: 'x', url: 'https://a.example' }).success).toBe(true);
  });

  it('creates a web watch with kind=web, an initial nextPollAt, and the interval', async (context) => {
    if (!dbUp) return context.skip();
    const result = (await run('watch.web', {
      name: 'Xtest-Web-create',
      url: 'https://example.com/status',
      mode: 'contains',
      pattern: 'resolved',
      intervalMinutes: 30,
      expiresInDays: 7,
    })) as { watchId: string; conversationId: string; mode: string; watching: string };
    createdConversationIds.push(result.conversationId);
    expect(result.mode).toBe('contains');
    expect(result.watching).toContain('example.com/status');

    const [row] = await db.select().from(watches).where(eq(watches.id, result.watchId));
    expect(row?.kind).toBe('web');
    expect(row?.pollIntervalSeconds).toBe(30 * 60);
    expect(row?.nextPollAt).toBeTruthy();
    expect(row?.status).toBe('active');
  });

  it('refuses a non-http(s) url at create time', async (context) => {
    if (!dbUp) return context.skip();
    await expect(
      run('watch.web', { name: 'Xtest-Web-ftp', url: 'ftp://example.com/x' }),
    ).rejects.toThrow();
  });

  it('lists a web watch with a readable summary', async (context) => {
    if (!dbUp) return context.skip();
    const created = (await run('watch.web', {
      name: 'Xtest-Web-list',
      url: 'https://example.com/deals',
      mode: 'change',
    })) as { conversationId: string };
    createdConversationIds.push(created.conversationId);
    const listed = (await run('watch.list', {})) as {
      watches: Array<{ name: string; kind: string; matching: string; url: string | null }>;
    };
    const web = listed.watches.find((w) => w.name === 'Xtest-Web-list');
    expect(web?.kind).toBe('web');
    expect(web?.url).toBe('https://example.com/deals');
    expect(web?.matching).toContain('change');
  });
});
