/**
 * Minimal Google REST client for the bot account. Raw fetch — no googleapis
 * dependency. The refresh token comes from scripts/auth-bot.ts.
 */
export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class GoogleApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    url: string,
  ) {
    super(`Google API ${status} on ${url}: ${body.slice(0, 300)}`);
  }
}

export class GoogleClient {
  private access: { token: string; expiresAt: number } | undefined;

  constructor(private opts: GoogleClientOptions) {}

  configured(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret && this.opts.refreshToken);
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        refresh_token: this.opts.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      throw new Error(
        `google token refresh failed: ${data.error ?? res.status} ${data.error_description ?? ''} — if the bot password changed, rerun pnpm auth:bot`,
      );
    }
    this.access = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return this.access.token;
  }

  async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.token();
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new GoogleApiError(res.status, text, url);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Build an RFC 2822 plain-text email and encode base64url for the Gmail API. */
export function buildRawEmail(input: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
  ];
  const message = `${headers.join('\r\n')}\r\n\r\n${input.body}`;
  return Buffer.from(message).toString('base64url');
}

/** Crude HTML → text (a proper readability pass arrives with the browser phase). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decode a Gmail message payload into plain text (prefers text/plain parts). */
export function extractGmailText(payload: GmailPayload | undefined): string {
  if (!payload) return '';
  const parts: GmailPayload[] = [];
  const walk = (p: GmailPayload) => {
    parts.push(p);
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);

  const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

  const plain = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return decode(plain.body?.data).trim();
  const html = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
  if (html) return htmlToText(decode(html.body?.data));
  return decode(payload.body?.data).trim();
}

export interface GmailPayload {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayload[];
  headers?: Array<{ name: string; value: string }>;
}

export function gmailHeader(payload: GmailPayload | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}
