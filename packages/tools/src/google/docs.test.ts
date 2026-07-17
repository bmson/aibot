import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { GoogleClient } from './client.js';
import {
  buildContentRequests,
  type DocsBatchRequest,
  documentText,
  registerDocsTools,
} from './docs.js';

const DEPS = { botEmail: 'bot@example.com', ownerEmail: 'owner@example.com' };

function toolsWith(api: ReturnType<typeof vi.fn>) {
  const registry = new ToolRegistry();
  registerDocsTools(registry, { client: { api } as unknown as GoogleClient, ...DEPS });
  return registry;
}

function insertText(requests: DocsBatchRequest[]): string {
  const insert = requests.find((r) => 'insertText' in r)?.insertText as
    | { text?: string }
    | undefined;
  return insert?.text ?? '';
}

describe('buildContentRequests', () => {
  it('inserts plain paragraphs as a single text block with no styling', () => {
    const { requests } = buildContentRequests('First line\nSecond line', 1);
    expect(requests).toEqual([
      { insertText: { location: { index: 1 }, text: 'First line\nSecond line' } },
    ]);
  });

  it('returns nothing for empty content', () => {
    expect(buildContentRequests('', 1)).toEqual({ requests: [], insertedLength: 0 });
  });

  it('styles headings over the exact paragraph range', () => {
    const { requests } = buildContentRequests('# Title\nBody', 1);
    expect(insertText(requests)).toBe('Title\nBody');
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 1, endIndex: 6 },
        paragraphStyle: { namedStyleType: 'HEADING_1' },
        fields: 'namedStyleType',
      },
    });
  });

  it('maps heading depth to the matching named style', () => {
    const { requests } = buildContentRequests('### Deep', 1);
    const style = requests.find((r) => 'updateParagraphStyle' in r)?.updateParagraphStyle as {
      paragraphStyle?: { namedStyleType?: string };
    };
    expect(style.paragraphStyle?.namedStyleType).toBe('HEADING_3');
  });

  it('coalesces consecutive bullets into one range but splits across a gap', () => {
    const { requests } = buildContentRequests('- a\n- bb\nplain\n- c', 1);
    const bullets = requests
      .filter((r) => 'createParagraphBullets' in r)
      .map((r) => (r.createParagraphBullets as { range: unknown }).range);
    // text "a\nbb\nplain\nc": "a"=[1,2), "bb"=[3,5) coalesce to [1,5];
    // "plain" breaks the run; "c"=[12,13).
    expect(bullets).toEqual([
      { startIndex: 1, endIndex: 5 },
      { startIndex: 12, endIndex: 13 },
    ]);
  });

  it('offsets every index when appending after existing text', () => {
    const { requests } = buildContentRequests('# H', 40, { leadingNewline: true });
    expect(requests[0]).toEqual({ insertText: { location: { index: 40 }, text: '\nH' } });
    // Leading newline occupies index 40; the heading text starts at 41.
    expect(requests).toContainEqual({
      updateParagraphStyle: {
        range: { startIndex: 41, endIndex: 42 },
        paragraphStyle: { namedStyleType: 'HEADING_1' },
        fields: 'namedStyleType',
      },
    });
  });

  it('keeps indices aligned to UTF-16 code units for astral characters', () => {
    // "😀" is two UTF-16 code units, so the heading on the next line starts at 1 + 2 + 1.
    const { requests } = buildContentRequests('😀\n# H', 1);
    const range = requests.find((r) => 'updateParagraphStyle' in r)?.updateParagraphStyle as {
      range: { startIndex: number };
    };
    expect(range.range.startIndex).toBe(4);
  });
});

describe('documentText', () => {
  it('flattens paragraph text runs and trims trailing newlines', () => {
    const text = documentText({
      body: {
        content: [
          {
            paragraph: {
              elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world' } }],
            },
          },
          { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
        ],
      },
    });
    expect(text).toBe('Hello world');
  });
});

describe('registerDocsTools', () => {
  it('creates the doc, writes styled content, and shares it with the owner', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ documentId: 'DOC-123_abc' }) // create
      .mockResolvedValueOnce({}) // batchUpdate
      .mockResolvedValueOnce({}); // share
    const tool = toolsWith(api).get('docs.create')?.tool;
    const result = (await tool?.execute(
      { title: 'Plan', content: '# Plan\n- one\n- two' },
      {} as never,
    )) as { documentId: string; url: string; sharedWith: string };

    expect(result).toEqual({
      documentId: 'DOC-123_abc',
      title: 'Plan',
      url: 'https://docs.google.com/document/d/DOC-123_abc/edit',
      sharedWith: 'owner@example.com',
    });

    const [createUrl, createInit] = api.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://docs.googleapis.com/v1/documents');
    expect(JSON.parse(String(createInit.body))).toEqual({ title: 'Plan' });

    const [batchUrl] = api.mock.calls[1] as [string];
    expect(batchUrl).toBe('https://docs.googleapis.com/v1/documents/DOC-123_abc:batchUpdate');

    const [shareUrl, shareInit] = api.mock.calls[2] as [string, RequestInit];
    expect(shareUrl).toBe(
      'https://www.googleapis.com/drive/v3/files/DOC-123_abc/permissions?sendNotificationEmail=false',
    );
    expect(JSON.parse(String(shareInit.body))).toEqual({
      role: 'writer',
      type: 'user',
      emailAddress: 'owner@example.com',
    });
  });

  it('skips the content batchUpdate when no body is given', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ documentId: 'DOC0000000' })
      .mockResolvedValueOnce({});
    const tool = toolsWith(api).get('docs.create')?.tool;
    await tool?.execute({ title: 'Empty', content: '' }, {} as never);
    // create + share only — no batchUpdate call.
    expect(api).toHaveBeenCalledTimes(2);
    expect((api.mock.calls[1] as [string])[0]).toContain('/permissions');
  });

  it('appends after the document end index on a fresh paragraph', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({ body: { content: [{ endIndex: 12 }] } }) // get
      .mockResolvedValueOnce({}); // batchUpdate
    const tool = toolsWith(api).get('docs.append')?.tool;
    await tool?.execute({ documentId: 'DOC0000000', content: 'more' }, {} as never);

    const [, batchInit] = api.mock.calls[1] as [string, RequestInit];
    const { requests } = JSON.parse(String(batchInit.body));
    expect(requests[0]).toEqual({ insertText: { location: { index: 11 }, text: '\nmore' } });
  });

  it('shares with a third party as an approval-gated, outward-facing tool', () => {
    const registered = toolsWith(vi.fn()).get('docs.share');
    expect(registered?.tool.risk).toBe('approval');
    expect(registered?.tool.acceptsUntrustedInput).toBe(false);
    expect(registered?.flags.outwardFacing).toBe(true);
  });

  it('keeps doc writes out of untrusted-trigger registries but allows reads to stay gated', () => {
    const registry = toolsWith(vi.fn());
    const unknown = registry.toolsForTask('unknown').map((t) => t.name);
    expect(unknown).not.toContain('docs.create');
    expect(unknown).not.toContain('docs.append');
    expect(unknown).not.toContain('docs.get');
    expect(unknown).not.toContain('docs.share');

    const owner = registry.toolsForTask('owner').map((t) => t.name);
    expect(owner).toEqual(['docs.create', 'docs.append', 'docs.get', 'docs.share']);
  });

  it('rejects a document id that is not a valid path segment', () => {
    const tool = toolsWith(vi.fn()).get('docs.get')?.tool;
    const parsed = tool?.inputSchema.safeParse({ documentId: '../../etc/passwd' });
    expect(parsed?.success).toBe(false);
  });
});
