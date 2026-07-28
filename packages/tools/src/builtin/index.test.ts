import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import {
  fetchPublicWebPage,
  isPublicIpAddress,
  looksLikeBotChallenge,
  registerBuiltinTools,
  WEB_FETCH_MAX_BYTES,
  type WebFetchIo,
  type WebFetchResponse,
} from './index.js';

// Verbatim (tag-stripped) bodies that real bot walls served the prod agent.
const DDG_CAPTCHA_202 =
  '--> DuckDuckGo DuckDuckGo Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human. Select all squares containing a duck: Submit Images not loading? Please email the following code to: error-lite@duckduckgo.com Code: d4cd0dabcf4caa22ad92fab40844c786 here . //-->';
const INDEED_CHALLENGE_403 =
  'Security Check - Indeed.com Additional Verification Required Please enable JavaScript to complete the security check. Return home Enable JavaScript and cookies to continue';

describe('looksLikeBotChallenge', () => {
  it('flags the DuckDuckGo CAPTCHA page even though it is served as HTTP 202', () => {
    expect(looksLikeBotChallenge(202, DDG_CAPTCHA_202)).toBe(true);
  });

  it('flags Cloudflare-style verification interstitials on 403', () => {
    expect(looksLikeBotChallenge(403, INDEED_CHALLENGE_403)).toBe(true);
  });

  it('leaves a real content page alone even when it mentions humans and checks', () => {
    const article = `${'Real article content. '.repeat(300)} This guide explains how sites verify you are human.`;
    expect(looksLikeBotChallenge(200, article)).toBe(false);
  });

  it('leaves ordinary small pages and errors alone', () => {
    expect(looksLikeBotChallenge(200, 'Weather in Vienna: 24C, sunny.')).toBe(false);
    expect(looksLikeBotChallenge(404, 'Not found')).toBe(false);
    expect(looksLikeBotChallenge(503, 'Service temporarily unavailable, retry later.')).toBe(false);
  });

  it('requires challenge language near the top of the page', () => {
    const buried = `${'x'.repeat(2500)} please complete the following challenge`;
    expect(looksLikeBotChallenge(403, buried)).toBe(false);
  });
});

const signal = new AbortController().signal;

function response(
  chunks: Uint8Array[] = [Buffer.from('ok')],
  options: {
    status?: number;
    location?: string;
    contentType?: string;
    contentEncoding?: string;
  } = {},
): WebFetchResponse & { cancel: ReturnType<typeof vi.fn<() => void>> } {
  return {
    status: options.status ?? 200,
    headers: {
      contentType: options.contentType ?? 'text/plain',
      contentEncoding: options.contentEncoding ?? '',
      location: options.location,
    },
    body: (async function* () {
      yield* chunks;
    })(),
    cancel: vi.fn<() => void>(),
  };
}

function publicResolver(): WebFetchIo['resolve'] {
  return async () => [{ address: '93.184.216.34', family: 4 }];
}

describe('web.fetch network boundary', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])('classifies %s as non-public', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '93.184.216.34', '2001:4860:4860::8888', '::ffff:8.8.8.8'])(
    'classifies %s as public',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it('rejects a private literal before making a request', async () => {
    const get = vi.fn<WebFetchIo['get']>();
    await expect(
      fetchPublicWebPage('http://169.254.169.254/latest/meta-data', signal, {
        resolve: publicResolver(),
        get,
      }),
    ).rejects.toThrow(/private or non-routable/);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects DNS answers if any address is private', async () => {
    const get = vi.fn<WebFetchIo['get']>();
    await expect(
      fetchPublicWebPage('https://mixed.example/', signal, {
        resolve: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
        get,
      }),
    ).rejects.toThrow(/private or non-routable/);
    expect(get).not.toHaveBeenCalled();
  });

  it('revalidates DNS after every redirect', async () => {
    const first = response([], { status: 302, location: 'http://internal.example/secret' });
    const get = vi.fn<WebFetchIo['get']>().mockResolvedValueOnce(first);
    const resolve = vi.fn<WebFetchIo['resolve']>(async (hostname) => [
      {
        address: hostname === 'internal.example' ? '10.0.0.5' : '93.184.216.34',
        family: 4,
      },
    ]);

    await expect(
      fetchPublicWebPage('https://public.example/start', signal, { resolve, get }),
    ).rejects.toThrow(/private or non-routable/);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(first.cancel).toHaveBeenCalledOnce();
  });

  it('caps redirect chains', async () => {
    const redirects: WebFetchResponse[] = [];
    const get = vi.fn<WebFetchIo['get']>(async (_url) => {
      const next = response([], { status: 302, location: '/again' });
      redirects.push(next);
      return next;
    });

    await expect(
      fetchPublicWebPage('https://public.example/start', signal, {
        resolve: publicResolver(),
        get,
      }),
    ).rejects.toThrow(/too many redirects/);
    expect(get).toHaveBeenCalledTimes(6);
    expect(redirects.every((item) => vi.mocked(item.cancel).mock.calls.length === 1)).toBe(true);
  });

  it.each(['https://user:secret@public.example/', 'http://public.example:8080/'])(
    'rejects unsafe URL authority %s',
    async (url) => {
      const get = vi.fn<WebFetchIo['get']>();
      await expect(
        fetchPublicWebPage(url, signal, { resolve: publicResolver(), get }),
      ).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('pins the request to the address that passed validation', async () => {
    const resolved = { address: '93.184.216.34', family: 4 as const };
    const get = vi.fn<WebFetchIo['get']>(async (_url, address) => {
      expect(address).toEqual(resolved);
      return response([Buffer.from('public')]);
    });

    const result = await fetchPublicWebPage('https://public.example/', signal, {
      resolve: async () => [resolved],
      get,
    });

    expect(result.body).toBe('public');
    expect(result.finalUrl).toBe('https://public.example/');
  });

  it('stops streaming once the response byte limit is reached', async () => {
    let reachedThirdChunk = false;
    const limited = response();
    limited.body = (async function* () {
      yield Buffer.alloc(200_000, 'a');
      yield Buffer.alloc(200_000, 'b');
      reachedThirdChunk = true;
      yield Buffer.alloc(200_000, 'c');
    })();

    const result = await fetchPublicWebPage('https://large.example/', signal, {
      resolve: publicResolver(),
      get: async () => limited,
    });

    expect(Buffer.byteLength(result.body)).toBe(WEB_FETCH_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(limited.cancel).toHaveBeenCalledOnce();
    expect(reachedThirdChunk).toBe(false);
  });

  it('rejects compressed responses instead of risking decompression bombs', async () => {
    const compressed = response([Buffer.from('compressed')], { contentEncoding: 'gzip' });
    await expect(
      fetchPublicWebPage('https://compressed.example/', signal, {
        resolve: publicResolver(),
        get: async () => compressed,
      }),
    ).rejects.toThrow(/compressed responses/);
    expect(compressed.cancel).toHaveBeenCalledOnce();
  });
});

describe('builtin trust capabilities', () => {
  it('does not expose owner-private reads or workspace writes to unknown tasks', () => {
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const unknown = registry.toolsForTask('unknown').map((tool) => tool.name);

    expect(unknown).not.toContain('memory.recall');
    expect(unknown).not.toContain('conversations.search');
    expect(unknown).not.toContain('goals.list');
    expect(unknown).not.toContain('workspace.read');
    expect(unknown).not.toContain('workspace.list');
    expect(unknown).not.toContain('workspace.write');
    expect(unknown).not.toContain('owner.notify');
    // Egress is denied to strangers too: a DKIM-valid unknown sender must not
    // drive HTTP requests or paid searches from the owner's IP.
    expect(unknown).not.toContain('web.fetch');
    expect(registry.toolsForTask('known').map((tool) => tool.name)).toContain('web.fetch');
  });

  it('lets mission/goal progress writers run under taint without an approval', () => {
    // Regression: a mission/goal work session almost always reads untrusted
    // content before it can summarise progress. Taint no longer strips tools
    // from a privileged registry, so availability alone is not the property
    // worth pinning — acceptsUntrustedInput is. It is what keeps these two off
    // the dispatcher's taintNeedsApproval path, so the loop can record progress
    // without prompting the owner on every step instead of silently repeating
    // step one forever.
    const registry = registerBuiltinTools(new ToolRegistry(), {
      embed: async () => [],
      workspace: {} as Parameters<typeof registerBuiltinTools>[1]['workspace'],
    });
    const owner = registry.toolsForTask('owner').map((tool) => tool.name);

    expect(owner).toContain('mission.update');
    expect(owner).toContain('goals.update_progress');
    expect(registry.get('mission.update')?.tool.acceptsUntrustedInput).toBe(true);
    expect(registry.get('goals.update_progress')?.tool.acceptsUntrustedInput).toBe(true);
  });
});
