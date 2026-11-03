import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPdfText,
  findMetaContent,
  findPreferredPdfUrl,
  htmlToText,
  looksLikeBotWall,
  looksLikePaywall,
} from '../src/extractText.js';

const fixturePdf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tiny.pdf'));

describe('HTML extraction', () => {
  const html = `
    <html><head>
      <meta content="https://publisher.example/a.pdf?x=1&amp;y=2" name="citation_pdf_url">
      <meta name="citation_title" content="A Real Title">
      <script>secretToken = "do-not-keep";</script>
    </head>
    <body><nav>Home</nav><article><p>The article body&nbsp;here.</p></article></body></html>
  `;

  it('reads citation meta regardless of attribute order and decodes entities', () => {
    expect(findMetaContent(html, 'citation_pdf_url')).toBe('https://publisher.example/a.pdf?x=1&y=2');
    expect(findMetaContent(html, 'citation_title')).toBe('A Real Title');
    expect(findPreferredPdfUrl(html)).toBe('https://publisher.example/a.pdf?x=1&y=2');
  });

  it('prefers the article text and drops scripts', () => {
    const text = htmlToText(html);
    expect(text).toContain('The article body here.');
    expect(text).not.toContain('secretToken');
    expect(text).not.toContain('Home');
  });

  it('falls back to an anchor PDF href', () => {
    const page = '<a href="/content/pdf/10.1/abc.pdf">PDF</a>';
    expect(findPreferredPdfUrl(page)).toBe('/content/pdf/10.1/abc.pdf');
  });

  it('recognizes a publisher access wall', () => {
    expect(looksLikePaywall('<p>Please purchase this article to continue reading.</p>')).toBe(true);
    expect(looksLikePaywall('<p>The mitochondria is the powerhouse of the cell.</p>')).toBe(false);
  });
});

describe('PDF extraction', () => {
  it('extracts text and page count from a fixture PDF', async () => {
    const extracted = await extractPdfText(new Uint8Array(fixturePdf), 40);
    expect(extracted.pageCount).toBe(2);
    expect(extracted.pagesExtracted).toBe(2);
    expect(extracted.text).toContain('Hello from the proxy fixture.');
    expect(extracted.text).toContain('Second page for the cap.');
  });

  it('stops at the page cap', async () => {
    const extracted = await extractPdfText(new Uint8Array(fixturePdf), 1);
    expect(extracted.pageCount).toBe(2);
    expect(extracted.pagesExtracted).toBe(1);
    expect(extracted.text).toContain('Hello from the proxy fixture.');
    expect(extracted.text).not.toContain('Second page');
  });
});

describe('looksLikeBotWall', () => {
  const fixture = (name: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

  it.each(['challenge-springer.html', 'challenge-ieee.html'])('%s is a bot wall', (f) => {
    const html = fixture(f);
    expect(looksLikeBotWall(html, htmlToText(html))).toBe(true);
  });

  it('a real article carrying the Cloudflare script is not a bot wall', () => {
    const html = fixture('synthetic-cloudflare-article.html');
    expect(htmlToText(html).length).toBeGreaterThan(1500);
    expect(looksLikeBotWall(html, htmlToText(html))).toBe(false);
  });

  it('a curly apostrophe still matches', () => {
    expect(
      looksLikeBotWall(
        '<title>x</title><p>We need to verify that you\u2019re not a robot.</p>',
        'We need to verify that you\u2019re not a robot.'
      )
    ).toBe(true);
  });

  it('a strong phrase deep inside a long article does not match', () => {
    const text = `${'Lorem ipsum dolor sit amet. '.repeat(250)}Just a moment...`;
    expect(looksLikeBotWall(`<title>Paper</title><p>${text}</p>`, text)).toBe(false);
  });

  it('a strong phrase in the title matches', () => {
    expect(looksLikeBotWall('<title>Just a moment...</title><p>hi</p>', 'hi')).toBe(true);
  });

  it('a weak marker on a nearly empty page matches', () => {
    expect(looksLikeBotWall('<script src="/cdn-cgi/challenge-platform/h/b"></script>', 'tiny')).toBe(true);
  });
});
