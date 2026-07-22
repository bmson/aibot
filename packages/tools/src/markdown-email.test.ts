import { describe, expect, it } from 'vitest';
import { buildRawEmail } from './google/client.js';
import { markdownToEmailHtml, markdownToPlainText } from './markdown-email.js';

function decode(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('markdownToEmailHtml', () => {
  it('renders bold, links, and bullet lists as HTML', () => {
    const html = markdownToEmailHtml(
      'Hello **there**\n\n- one\n- two\n\nSee [site](https://x.io).',
    );
    expect(html).toContain('<strong>there</strong>');
    expect(html).toContain('<ul');
    expect(html).toContain('<li style="margin:2px 0">one</li>');
    expect(html).toContain('<a href="https://x.io" style="color:#1155cc">site</a>');
  });

  it('escapes HTML so model text cannot inject markup', () => {
    const html = markdownToEmailHtml('watch out <script>alert(1)</script> & "quotes"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('does not emit a raw url from a mangled link and keeps underscores intact', () => {
    const html = markdownToEmailHtml('[docs](https://a.com/foo_bar)');
    expect(html).toContain('href="https://a.com/foo_bar"');
    expect(html).not.toContain('<em>');
  });
});

describe('markdownToPlainText', () => {
  it('strips markers and turns links into "text (url)"', () => {
    const plain = markdownToPlainText('# Title\n\n**Bold** and [site](https://x.io)\n\n- item');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('#');
    expect(plain).toContain('Title');
    expect(plain).toContain('Bold and site (https://x.io)');
    expect(plain).toContain('- item');
  });
});

describe('buildRawEmail multipart', () => {
  it('builds a multipart/alternative message with both text and html parts', () => {
    const raw = buildRawEmail({
      from: '"AI Bot" <bot@x.io>',
      to: ['owner@x.io'],
      subject: 'Re: Plan',
      body: 'Plain fallback',
      html: '<div>rich</div>',
      inReplyTo: '<abc@mail>',
      references: '<abc@mail>',
    });
    const message = decode(raw);
    expect(message).toContain('Content-Type: multipart/alternative; boundary="');
    expect(message).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(message).toContain('Content-Type: text/html; charset=UTF-8');
    expect(message).toContain('Plain fallback');
    expect(message).toContain('<div>rich</div>');
    expect(message).toContain('In-Reply-To: <abc@mail>');
  });

  it('stays text/plain when no html is supplied (backward compatible)', () => {
    const raw = buildRawEmail({
      from: 'bot@x.io',
      to: ['owner@x.io'],
      subject: 'Hi',
      body: 'just text',
    });
    const message = decode(raw);
    expect(message).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(message).not.toContain('multipart/alternative');
    expect(message.endsWith('just text')).toBe(true);
  });
});
