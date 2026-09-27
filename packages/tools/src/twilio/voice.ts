import { AmbiguousTwilioDeliveryError } from './client.js';

/**
 * Twilio Programmable Voice over plain REST (no SDK), mirroring TwilioClient:
 * injectable fetch, bounded timeouts, and transport failures on a create
 * reported as ambiguous — the call may already be ringing, so it is never
 * retried blindly.
 */

export interface PlaceCallInput {
  to: string;
  /** Inline TwiML: the disclosure <Say>, then <Connect><Stream>. */
  twiml: string;
  statusCallback: string;
  asyncAmdStatusCallback: string;
  /** Twilio ends the call itself after this many seconds — a hard ceiling. */
  timeLimitSeconds: number;
}

export interface TwilioCallDetails {
  status: string;
  durationSeconds: number | null;
  /** Twilio reports price as a negative decimal string once the call is rated. */
  priceUsd: number | null;
  answeredBy: string | null;
}

export interface VoiceDialer {
  configured(): boolean;
  placeCall(input: PlaceCallInput): Promise<{ sid: string }>;
  hangup(sid: string): Promise<void>;
  getCall(sid: string): Promise<TwilioCallDetails>;
}

const CALL_SID = /^CA[0-9a-f]{32}$/i;

export class TwilioVoiceClient implements VoiceDialer {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
  ) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  configured(): boolean {
    return Boolean(this.accountSid && this.authToken && this.fromNumber);
  }

  private url(path: string): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}${path}`;
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchFn(url, {
      ...init,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  async placeCall(input: PlaceCallInput): Promise<{ sid: string }> {
    const body = new URLSearchParams({
      To: input.to,
      From: this.fromNumber,
      Twiml: input.twiml,
      StatusCallback: input.statusCallback,
      StatusCallbackMethod: 'POST',
      MachineDetection: 'DetectMessageEnd',
      AsyncAmd: 'true',
      AsyncAmdStatusCallback: input.asyncAmdStatusCallback,
      AsyncAmdStatusCallbackMethod: 'POST',
      TimeLimit: String(Math.max(60, Math.round(input.timeLimitSeconds))),
      // Ring long enough for a person to pick up, not long enough to camp on voicemail.
      Timeout: '30',
    });
    for (const event of ['initiated', 'ringing', 'answered', 'completed'])
      body.append('StatusCallbackEvent', event);

    let res: Response;
    let text: string;
    try {
      res = await this.request(this.url('/Calls.json'), { method: 'POST', body });
      text = await res.text();
    } catch (error) {
      throw new AmbiguousTwilioDeliveryError(
        `Twilio call outcome is unknown after a transport failure: ${String(error)}`,
        error,
      );
    }
    let data: { sid?: string; message?: string; code?: number } = {};
    try {
      data = text ? (JSON.parse(text) as typeof data) : {};
    } catch {
      // The status-bearing error below still describes it.
    }
    if (res.status === 408 || res.status >= 500 || (res.ok && !data.sid))
      throw new AmbiguousTwilioDeliveryError(
        `Twilio call outcome is unknown: ${data.code ?? res.status} ${data.message ?? text.slice(0, 200)}`,
      );
    if (!res.ok)
      throw new Error(
        `twilio call failed: ${data.code ?? res.status} ${data.message ?? text.slice(0, 200)}`,
      );
    return { sid: data.sid as string };
  }

  async hangup(sid: string): Promise<void> {
    if (!CALL_SID.test(sid)) throw new Error('invalid Twilio Call SID');
    const res = await this.request(this.url(`/Calls/${sid}.json`), {
      method: 'POST',
      body: new URLSearchParams({ Status: 'completed' }),
    });
    // 404: the call is already gone, which is what hanging up wanted.
    if (!res.ok && res.status !== 404) throw new Error(`twilio hangup failed: ${res.status}`);
  }

  async getCall(sid: string): Promise<TwilioCallDetails> {
    if (!CALL_SID.test(sid)) throw new Error('invalid Twilio Call SID');
    const res = await this.request(this.url(`/Calls/${sid}.json`));
    const data = (await res.json().catch(() => ({}))) as {
      status?: string;
      duration?: string | null;
      price?: string | null;
      price_unit?: string | null;
      answered_by?: string | null;
    };
    if (!res.ok || !data.status) throw new Error(`twilio call lookup failed: ${res.status}`);
    const duration = data.duration == null ? null : Number(data.duration);
    const price =
      data.price == null || (data.price_unit && data.price_unit !== 'USD')
        ? null
        : Math.abs(Number(data.price));
    return {
      status: data.status,
      durationSeconds: Number.isFinite(duration) ? duration : null,
      priceUsd: Number.isFinite(price) ? price : null,
      answeredBy: data.answered_by ?? null,
    };
  }
}

/** Escape text for inclusion in TwiML. */
export function twimlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The TwiML an outbound call runs when answered: the fixed AI disclosure,
 * spoken by the network, then the bidirectional media stream to the agent.
 * The one-shot token rides as a stream parameter, so it never appears in a URL.
 */
export function outboundCallTwiml(input: {
  disclosure: string;
  streamUrl: string;
  callId: string;
  streamToken: string;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Response>',
    `<Say voice="Polly.Joanna-Neural">${twimlText(input.disclosure)}</Say>`,
    '<Connect>',
    `<Stream url="${twimlText(input.streamUrl)}">`,
    `<Parameter name="callId" value="${twimlText(input.callId)}"/>`,
    `<Parameter name="token" value="${twimlText(input.streamToken)}"/>`,
    '</Stream>',
    '</Connect>',
    '</Response>',
  ].join('');
}
