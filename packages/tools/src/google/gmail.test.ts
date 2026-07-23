import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerGmailTools } from './gmail.js';

const outbound = {
  to: ['person@example.com'],
  subject: 'Research summary',
  body: 'Quoted public-web findings',
  register: 'email_professional' as const,
};

function context(tainted: boolean): ToolContext {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    trust: 'owner',
    tainted,
    db: {} as ToolContext['db'],
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  };
}

describe('Gmail outbound security', () => {
  it('allows owner-led external-content email only through an outward approval boundary', () => {
    const registry = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
    });
    const registered = registry.get('gmail.send');

    expect(registered?.tool.acceptsUntrustedInput).toBe(true);
    expect(registered?.tool.risk).toBe('approval');
    expect(registered?.flags).toMatchObject({
      outwardFacing: true,
      networkEgress: true,
      blanketAllowIneligible: true,
    });
    expect(registry.toolsForTask('unknown').map((tool) => tool.name)).not.toContain('gmail.send');
    expect(registry.toolsForTask('owner').map((tool) => tool.name)).toContain('gmail.send');
  });

  it('never sends tainted content through the private voice-rewrite context', async () => {
    const prepareOutbound = vi.fn(async () => ({ text: 'voice rewritten' }));
    const registry = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
      prepareOutbound,
    });
    const prepare = registry.get('gmail.send')?.tool.prepare;
    expect(prepare).toBeDefined();
    if (!prepare) return;

    await expect(prepare(outbound, context(true))).resolves.toEqual(outbound);
    expect(prepareOutbound).not.toHaveBeenCalled();

    await expect(prepare(outbound, context(false))).resolves.toMatchObject({
      body: 'voice rewritten',
    });
    expect(prepareOutbound).toHaveBeenCalledOnce();
  });

  it('attaches an allowlisted workspace file and rejects a disallowed path', async () => {
    const api = vi.fn().mockResolvedValue({ id: 'sent-1', threadId: 't-1' });
    const readBytes = vi.fn(async () => Buffer.from('CSVDATA'));
    const registry = registerGmailTools(new ToolRegistry(), {
      client: { api } as unknown as never,
      botEmail: 'bot@example.com',
      workspace: { readBytes },
    });
    const send = registry.get('gmail.send')?.tool;

    await send?.execute(
      { ...outbound, attachments: [{ workspacePath: 'code/task-1/out.csv' }] },
      context(false),
    );
    expect(readBytes).toHaveBeenCalledWith('code/task-1/out.csv');
    const [, init] = api.mock.calls[0] as [string, RequestInit];
    const raw = JSON.parse(String(init.body)).raw as string;
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain('filename="out.csv"');

    await expect(
      send?.execute(
        { ...outbound, attachments: [{ workspacePath: 'b-bot/browser/profile.tar.enc' }] },
        context(false),
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it('names attachments on the send approval card', () => {
    const summary = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
    })
      .get('gmail.send')
      ?.tool.approvalSummary?.({
        ...outbound,
        attachments: [{ workspacePath: 'code/t/chart.png' }],
      });
    expect(summary).toContain('chart.png');
  });

  it('keys create_draft idempotently: stable for the same draft, distinct for a different body', () => {
    const key = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
    }).get('gmail.create_draft')?.tool.idempotencyKey;
    expect(key).toBeDefined();
    if (!key) return;
    const ctx = context(false);
    expect(key(outbound, ctx)).toBe(key(outbound, ctx));
    expect(key(outbound, ctx)).not.toBe(key({ ...outbound, body: 'different' }, ctx));
  });
});

describe('gmail.modify', () => {
  function modifyTool(api = vi.fn()) {
    return registerGmailTools(new ToolRegistry(), {
      client: { api } as unknown as never,
      botEmail: 'bot@example.com',
    }).get('gmail.modify');
  }

  it('is autonomous for labels/mark-read and approval for archive', () => {
    const risk = modifyTool()?.tool.risk;
    expect(typeof risk).toBe('function');
    if (typeof risk !== 'function') return;
    const ctx = context(false);
    expect(risk({ threadId: 't', addLabels: [], removeLabels: [], archive: false }, ctx)).toBe(
      'autonomous',
    );
    expect(risk({ threadId: 't', addLabels: [], removeLabels: [], archive: true }, ctx)).toBe(
      'approval',
    );
    expect(modifyTool()?.flags).toMatchObject({ privateWrite: true });
  });

  it('translates markRead and archive into label mutations on the bot mailbox', async () => {
    const api = vi.fn().mockResolvedValue({});
    await modifyTool(api)?.tool.execute(
      {
        threadId: 'thread-9',
        addLabels: ['Waiting'],
        removeLabels: [],
        markRead: true,
        archive: true,
      },
      {} as never,
    );
    const [url, init] = api.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/threads/thread-9/modify');
    expect(JSON.parse(String(init.body))).toEqual({
      addLabelIds: ['Waiting'],
      removeLabelIds: ['UNREAD', 'INBOX'],
    });
  });
});
