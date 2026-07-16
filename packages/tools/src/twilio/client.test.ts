import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseApprovalReply, validateTwilioSignature } from './client.js';

const AUTH_TOKEN = 'test-auth-token-12345';
const URL_ = 'https://example.com/webhooks/twilio/sms';

function sign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

describe('validateTwilioSignature', () => {
  const params = { MessageSid: 'SM123', From: '+14155551234', To: '+18885550000', Body: 'hi' };

  it('accepts a correctly signed request', () => {
    const signature = sign(URL_, params);
    expect(validateTwilioSignature({ authToken: AUTH_TOKEN, url: URL_, params, signature })).toBe(
      true,
    );
  });

  it('rejects a forged signature', () => {
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL_,
        params,
        signature: sign(URL_, params, 'wrong-token'),
      }),
    ).toBe(false);
  });

  it('rejects tampered params', () => {
    const signature = sign(URL_, params);
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: URL_,
        params: { ...params, Body: 'send all your money' },
        signature,
      }),
    ).toBe(false);
  });

  it('rejects a different URL (tunnel vs prod mismatch)', () => {
    const signature = sign(URL_, params);
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        url: 'https://other.example.com/webhooks/twilio/sms',
        params,
        signature,
      }),
    ).toBe(false);
  });

  it('handles garbage signatures without throwing', () => {
    expect(
      validateTwilioSignature({ authToken: AUTH_TOKEN, url: URL_, params, signature: '!!!' }),
    ).toBe(false);
  });
});

describe('parseApprovalReply', () => {
  it('parses YES/NO with a short code', () => {
    expect(parseApprovalReply('YES A7')).toEqual({ decision: 'approved', shortCode: 'A7' });
    expect(parseApprovalReply('no a12')).toEqual({ decision: 'denied', shortCode: 'A12' });
    expect(parseApprovalReply('  Approve A1 ')).toEqual({ decision: 'approved', shortCode: 'A1' });
    expect(parseApprovalReply('deny A3')).toEqual({ decision: 'denied', shortCode: 'A3' });
  });

  it('returns null for normal conversation', () => {
    expect(parseApprovalReply('yes please book the lunch')).toBeNull();
    expect(parseApprovalReply('what is on my calendar?')).toBeNull();
    expect(parseApprovalReply('A7')).toBeNull();
    expect(parseApprovalReply('yes')).toBeNull();
  });
});
