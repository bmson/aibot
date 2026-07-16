import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal Twilio REST client (fetch + basic auth — no SDK). Injectable so
 * tests can fake delivery.
 */
export interface SmsSender {
  send(to: string, body: string): Promise<{ sid: string }>;
}

export class TwilioClient implements SmsSender {
  constructor(
    private accountSid: string,
    private authToken: string,
    private fromNumber: string,
  ) {}

  configured(): boolean {
    return Boolean(this.accountSid && this.authToken && this.fromNumber);
  }

  async send(to: string, body: string): Promise<{ sid: string }> {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.fromNumber, Body: body }),
      },
    );
    const data = (await res.json()) as { sid?: string; message?: string; code?: number };
    if (!res.ok || !data.sid) {
      throw new Error(`twilio send failed: ${data.code ?? res.status} ${data.message ?? ''}`);
    }
    return { sid: data.sid };
  }
}

/**
 * Validate X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted form
 * params concatenated as key+value)). Per Twilio's security docs; the URL must
 * be the EXACT public URL Twilio requested (scheme, host, path, query).
 */
export function validateTwilioSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string;
}): boolean {
  const data =
    input.url +
    Object.keys(input.params)
      .sort()
      .map((k) => k + input.params[k])
      .join('');
  const expected = createHmac('sha1', input.authToken).update(data, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(input.signature, 'base64');
  } catch {
    return false;
  }
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** "YES A7" / "no a12" → an approval resolution; anything else → null. */
export function parseApprovalReply(
  body: string,
): { decision: 'approved' | 'denied'; shortCode: string } | null {
  const match = body.trim().match(/^(yes|no|approve|deny)\s+(A\d{1,4})$/i);
  if (!match) return null;
  const word = (match[1] as string).toLowerCase();
  return {
    decision: word === 'yes' || word === 'approve' ? 'approved' : 'denied',
    shortCode: (match[2] as string).toUpperCase(),
  };
}
