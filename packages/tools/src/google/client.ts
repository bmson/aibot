/**
 * Minimal Google REST client for the bot account. Raw fetch — no googleapis
 * dependency. The refresh token comes from scripts/auth-bot.ts.
 */
export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** Additional attempts for token refreshes and idempotent API reads. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Maximum decoded HTTP response body accepted from Google. */
  maxResponseBytes?: number;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value as number)) : fallback;
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

/** A mutating request may have committed even though its response was lost. */
export class AmbiguousGoogleMutationError extends Error {
  readonly deliveryMayHaveSucceeded = true;

  constructor(
    message: string,
    readonly originalError?: unknown,
  ) {
    super(message);
    this.name = 'AmbiguousGoogleMutationError';
  }
}

export function isAmbiguousGoogleMutationError(
  error: unknown,
): error is AmbiguousGoogleMutationError {
  return (
    error instanceof AmbiguousGoogleMutationError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { deliveryMayHaveSucceeded?: unknown }).deliveryMayHaveSucceeded === true)
  );
}

export class GoogleClient {
  private access: { token: string; expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxResponseBytes: number;

  constructor(private opts: GoogleClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = boundedNumber(opts.timeoutMs, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
    this.maxRetries = Math.floor(
      boundedNumber(opts.maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES),
    );
    this.retryBaseDelayMs = boundedNumber(
      opts.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      0,
      MAX_RETRY_DELAY_MS,
    );
    this.maxResponseBytes = Math.floor(
      boundedNumber(opts.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1, MAX_RESPONSE_BYTES),
    );
  }

  configured(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret && this.opts.refreshToken);
  }

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    if (!this.refreshing) {
      this.refreshing = this.refreshToken().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async refreshToken(): Promise<string> {
    let attempt = 0;
    while (true) {
      let res: Response;
      try {
        res = await this.fetchWithTimeout(TOKEN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.opts.clientId,
            client_secret: this.opts.clientSecret,
            refresh_token: this.opts.refreshToken,
            grant_type: 'refresh_token',
          }),
        });
      } catch (error) {
        if (attempt >= this.maxRetries) throw error;
        await this.waitBeforeRetry(undefined, attempt++);
        continue;
      }

      const text = await boundedResponseText(res, MAX_TOKEN_RESPONSE_BYTES);
      if (isTransientStatus(res.status) && attempt < this.maxRetries) {
        await this.waitBeforeRetry(res, attempt++);
        continue;
      }
      let data: {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      } = {};
      try {
        data = text ? (JSON.parse(text) as typeof data) : {};
      } catch {
        // Preserve the status/body in the stable error below.
      }
      if (!res.ok || !data.access_token) {
        throw new Error(
          `google token refresh failed: ${data.error ?? res.status} ${data.error_description ?? text.slice(0, 200)} — if the bot password changed, rerun pnpm auth:bot`,
        );
      }
      this.access = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      };
      return this.access.token;
    }
  }

  async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    assertGoogleApiUrl(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const retryableRead = method === 'GET' || method === 'HEAD';
    let retries = 0;
    let refreshedAfterUnauthorized = false;

    while (true) {
      const token = await this.token();
      const headers = new Headers(init.headers);
      if (init.body && !headers.has('content-type'))
        headers.set('content-type', 'application/json');
      headers.set('authorization', `Bearer ${token}`);

      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, { ...init, method, headers });
      } catch (error) {
        if (!retryableRead) {
          throw new AmbiguousGoogleMutationError(
            `Google mutation outcome is unknown after a transport failure: ${String(error)}`,
            error,
          );
        }
        if (init.signal?.aborted || retries >= this.maxRetries) throw error;
        await this.waitBeforeRetry(undefined, retries++);
        continue;
      }

      let text: string;
      try {
        text = await boundedResponseText(res, this.maxResponseBytes);
      } catch (error) {
        if (!retryableRead) {
          throw new AmbiguousGoogleMutationError(
            `Google mutation outcome is unknown because its response was interrupted: ${String(error)}`,
            error,
          );
        }
        throw error;
      }
      if (res.status === 401 && !refreshedAfterUnauthorized) {
        // A 401 definitively rejected the request, so even mutations are safe
        // to retry once after discarding the rejected access token.
        if (this.access?.token === token) this.access = undefined;
        refreshedAfterUnauthorized = true;
        continue;
      }
      if (retryableRead && isTransientStatus(res.status) && retries < this.maxRetries) {
        await this.waitBeforeRetry(res, retries++);
        continue;
      }
      if (!retryableRead && (res.status === 408 || res.status >= 500)) {
        throw new AmbiguousGoogleMutationError(
          `Google mutation outcome is unknown after HTTP ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      if (!res.ok) throw new GoogleApiError(res.status, text, url);
      try {
        return (text ? JSON.parse(text) : {}) as T;
      } catch (error) {
        if (!retryableRead) {
          throw new AmbiguousGoogleMutationError(
            `Google mutation succeeded but returned an unreadable response: ${String(error)}`,
            error,
          );
        }
        throw error;
      }
    }
  }

  /** Authenticated, bounded GET for Drive downloads and exports. */
  async apiBytes(
    url: string,
    init: RequestInit = {},
  ): Promise<{ body: Buffer; contentType: string }> {
    assertGoogleApiUrl(url);
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error('apiBytes supports read requests only');
    }
    let retries = 0;
    let refreshedAfterUnauthorized = false;

    while (true) {
      const token = await this.token();
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, { ...init, method, headers });
      } catch (error) {
        if (init.signal?.aborted || retries >= this.maxRetries) throw error;
        await this.waitBeforeRetry(undefined, retries++);
        continue;
      }
      if (res.status === 401 && !refreshedAfterUnauthorized) {
        await res.body?.cancel().catch(() => {});
        if (this.access?.token === token) this.access = undefined;
        refreshedAfterUnauthorized = true;
        continue;
      }
      if (isTransientStatus(res.status) && retries < this.maxRetries) {
        await res.body?.cancel().catch(() => {});
        await this.waitBeforeRetry(res, retries++);
        continue;
      }
      if (!res.ok) {
        const text = await boundedResponseText(res, this.maxResponseBytes);
        throw new GoogleApiError(res.status, text, url);
      }
      return {
        body: await boundedResponseBytes(res, this.maxResponseBytes),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
      };
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('request aborted');
    const controller = new AbortController();
    const abort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error(`Google request timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abort);
    }
  }

  private async waitBeforeRetry(response: Response | undefined, attempt: number): Promise<void> {
    const retryAfter = response ? retryAfterMs(response.headers.get('retry-after')) : undefined;
    const exponential = this.retryBaseDelayMs * 2 ** attempt;
    await this.sleep(Math.min(MAX_RETRY_DELAY_MS, retryAfter ?? exponential));
  }
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Google response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Google response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Google response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Google response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function assertGoogleApiUrl(value: string): void {
  const url = new URL(value);
  const googleApiHost =
    url.hostname === 'www.googleapis.com' || url.hostname.endsWith('.googleapis.com');
  if (url.protocol !== 'https:' || !googleApiHost || url.username || url.password || url.port) {
    throw new Error(`refusing non-Google API URL: ${url.origin}`);
  }
}

/**
 * Build an RFC 2822 email and encode base64url for the Gmail API. When `html` is
 * supplied the message is multipart/alternative — a plain-text part (for clients
 * that can't render HTML) plus the rich HTML part — otherwise it stays text/plain.
 */
export function buildRawEmail(input: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const header = (name: string, value: string): string => {
    if (/[\r\n]/.test(value)) throw new Error(`${name} contains a forbidden line break`);
    return `${name}: ${value}`;
  };
  const baseHeaders = [
    header('From', input.from),
    header('To', input.to.join(', ')),
    header('Subject', input.subject),
    'MIME-Version: 1.0',
    ...(input.inReplyTo ? [header('In-Reply-To', input.inReplyTo)] : []),
    ...(input.references ? [header('References', input.references)] : []),
  ];

  let message: string;
  if (input.html) {
    // A fixed boundary token is fine — the parts are our own content and the
    // boundary string cannot appear in base64-independent UTF-8 bodies here.
    const boundary = 'asst_alt_boundary_7f3c9e';
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.body,
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      input.html,
      `--${boundary}--`,
      '',
    ];
    const headers = [...baseHeaders, `Content-Type: multipart/alternative; boundary="${boundary}"`];
    message = `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
  } else {
    const headers = [...baseHeaders, 'Content-Type: text/plain; charset=UTF-8'];
    message = `${headers.join('\r\n')}\r\n\r\n${input.body}`;
  }
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
  /** Non-empty for an attachment part (as opposed to an inline body part). */
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPayload[];
  headers?: Array<{ name: string; value: string }>;
}

export interface GmailAttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

/** Collect real file attachments (named parts carrying an attachmentId) from a payload. */
export function collectGmailAttachments(payload: GmailPayload | undefined): GmailAttachmentRef[] {
  if (!payload) return [];
  const found: GmailAttachmentRef[] = [];
  const walk = (p: GmailPayload) => {
    const attachmentId = p.body?.attachmentId;
    if (p.filename && attachmentId) {
      found.push({
        filename: p.filename,
        mimeType: (p.mimeType || 'application/octet-stream').split(';')[0]?.trim() ?? '',
        attachmentId,
        size: p.body?.size ?? 0,
      });
    }
    for (const child of p.parts ?? []) walk(child);
  };
  walk(payload);
  return found;
}

export function gmailHeader(payload: GmailPayload | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}
