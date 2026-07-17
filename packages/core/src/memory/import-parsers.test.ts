import { describe, expect, it } from 'vitest';
import {
  ageScaledConfidence,
  detectKind,
  parseJsonExport,
  parseMbox,
  parseText,
  windowUnits,
} from './import-parsers.js';

const MBOX = `From alice@example.com Mon Mar 04 10:00:00 2019
From: Alice Example <alice@example.com>
To: baldvin@example.com
Subject: Flat in Reykjavik
Date: Mon, 4 Mar 2019 10:00:00 +0000

Hey! The flat on Laugavegur is available from April.
> quoted reply line that should vanish
Let me know if you want it.

From bob@example.com Tue Jun 11 09:30:00 2024
From: Bob Builder <bob@example.com>
Subject: Padel on Tuesday
Date: Tue, 11 Jun 2024 09:30:00 +0000
Content-Type: multipart/alternative; boundary="000abc"

--000abc
Content-Type: text/plain; charset=UTF-8

Padel court booked for Tuesday 18:00.
QWxhZGRpbjpvcGVuIHNlc2FtZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
--000abc--
`;

describe('parseMbox', () => {
  it('splits messages, reads headers, strips quotes/base64/MIME noise', () => {
    const units = parseMbox(MBOX);
    expect(units).toHaveLength(2);

    expect(units[0]?.date?.getUTCFullYear()).toBe(2019);
    expect(units[0]?.header).toContain('Alice Example');
    expect(units[0]?.header).toContain('Flat in Reykjavik');
    expect(units[0]?.text).toContain('Laugavegur');
    expect(units[0]?.text).not.toContain('quoted reply');

    expect(units[1]?.date?.getUTCFullYear()).toBe(2024);
    expect(units[1]?.text).toContain('Padel court booked');
    expect(units[1]?.text).not.toContain('QWxhZGRpbjpvcGVuIHNlc2FtZQ');
    expect(units[1]?.text).not.toContain('Content-Type');
  });
});

describe('parseJsonExport', () => {
  it('reads arrays of messages with flexible keys', () => {
    const units = parseJsonExport(
      JSON.stringify([
        { date: '2020-05-01T12:00:00Z', from: 'Anna', text: 'Moving to Oslo next month!' },
        { timestamp: 1718100000, sender: 'Baldvin', content: 'Congrats!' },
        { text: '' },
      ]),
    );
    expect(units).toHaveLength(2);
    expect(units[0]?.date?.getUTCFullYear()).toBe(2020);
    expect(units[0]?.header).toBe('From Anna');
    expect(units[1]?.date?.getUTCFullYear()).toBe(2024);
  });

  it('accepts a {messages: []} wrapper and rejects junk', () => {
    expect(parseJsonExport('{"messages":[{"text":"hello there"}]}')).toHaveLength(1);
    expect(parseJsonExport('not json at all')).toHaveLength(0);
  });
});

describe('parseText + windowUnits', () => {
  it('merges paragraphs into units and windows preserve order', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'x'.repeat(200)}`).join(
      '\n\n',
    );
    const units = parseText(text);
    expect(units.length).toBeGreaterThan(1);
    const windows = windowUnits(units, 2000);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]?.text).toContain('Paragraph 0');
  });

  it('window date is the median unit date', () => {
    const windows = windowUnits(
      [
        { date: new Date('2019-01-01'), header: '', text: 'a' },
        { date: new Date('2021-01-01'), header: '', text: 'b' },
        { date: new Date('2024-01-01'), header: '', text: 'c' },
      ],
      100000,
    );
    expect(windows[0]?.date?.getUTCFullYear()).toBe(2021);
  });
});

describe('ageScaledConfidence', () => {
  const now = new Date('2026-07-16');
  it('older facts start lower, floored, and unknown ages are capped', () => {
    const fresh = ageScaledConfidence(0.8, new Date('2026-07-01'), now);
    const old = ageScaledConfidence(0.8, new Date('2019-07-01'), now);
    const ancient = ageScaledConfidence(0.8, new Date('1995-01-01'), now);
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(ancient);
    expect(ancient).toBeGreaterThanOrEqual(0.8 * 0.35 - 1e-9);
    expect(ageScaledConfidence(0.9, null, now)).toBeLessThanOrEqual(0.6);
  });
});

describe('detectKind', () => {
  it('sniffs mbox, json, and falls back to text', () => {
    expect(detectKind('mail.mbox', 'whatever')).toBe('mbox');
    expect(detectKind('notes.txt', 'From alice')).toBe('text');
    expect(detectKind('anything.bin', 'From alice@example.com Mon Mar 04 10:00:00 2019')).toBe(
      'mbox',
    );
    expect(detectKind('chat.json', '[]')).toBe('json');
    expect(detectKind('data.dat', '[{"text":"hi"}]')).toBe('json');
    expect(detectKind('diary.md', '# My year')).toBe('text');
  });
});
