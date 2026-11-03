import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPdfText,
  findLinkingHubRedirect,
  findMetaContent,
  findPreferredPdfUrl,
  htmlToText,
  looksLikeAbstractOnly,
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

  it.each([
    'Client Challenge',
    'Just a moment...',
    'Attention Required! | Cloudflare',
    '  Just a moment... | Example Publisher ',
    'Client Challenge - Example',
  ])('the interstitial title %j matches', (title) => {
    expect(looksLikeBotWall(`<title>${title}</title><p>hi</p>`, 'hi')).toBe(true);
  });

  it.each([
    'Lightweight client challenge-response authentication for IoT',
    'Client challenge-response authentication for IoT',
    'Just a moment...: timing attacks in practice',
  ])('a real article titled %j is not a bot wall', (title) => {
    const body = 'Invented article body sentence about authentication protocols. '.repeat(60);
    const html = `<html><head><title>${title}</title></head>
      <body><article><p>${body}</p></article></body></html>`;
    const text = htmlToText(html);
    expect(text.length).toBeGreaterThan(1500);
    expect(looksLikeBotWall(html, text)).toBe(false);
  });

  it('a real article repeating that title in its opening heading is not a bot wall', () => {
    const body = 'Invented article body sentence about authentication protocols. '.repeat(60);
    const title = 'Lightweight client challenge-response authentication for IoT';
    const html = `<html><head><title>${title}</title></head>
      <body><article><h1>${title}</h1><p>${body}</p></article></body></html>`;
    expect(looksLikeBotWall(html, htmlToText(html))).toBe(false);
  });

  it('a long article with a short noscript carrying a strong phrase is not a bot wall', () => {
    const body = 'Invented article body sentence for the noscript case. '.repeat(60);
    const html = `<html><head><title>Paper</title></head><body>
      <noscript>Please enable JavaScript. Enable JavaScript and cookies to continue.</noscript>
      <article><p>${body}</p></article></body></html>`;
    const text = htmlToText(html);
    expect(text.length).toBeGreaterThan(1500);
    expect(looksLikeBotWall(html, text)).toBe(false);
  });

  it('a weak marker on a nearly empty page matches', () => {
    expect(looksLikeBotWall('<script src="/cdn-cgi/challenge-platform/h/b"></script>', 'tiny')).toBe(true);
  });
});

const readFixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

describe('findLinkingHubRedirect', () => {
  const html = readFixture('elsevier-linkinghub.html');
  const EXPECTED = 'https://www.sciencedirect.com/science/article/pii/S0167404825001981?via%3Dihub';

  it('decodes the redirectURL field on the proxied linkinghub host', () => {
    expect(
      findLinkingHubRedirect(html, 'https://linkinghub-elsevier-com.ezproxy.neu.edu/retrieve/pii/S0167404825001981')
    ).toBe(EXPECTED);
  });

  it('decodes the redirectURL field on linkinghub.elsevier.com', () => {
    expect(findLinkingHubRedirect(html, 'https://linkinghub.elsevier.com/retrieve/pii/S0167404825001981')).toBe(EXPECTED);
  });

  it('ignores the same HTML on any other host', () => {
    expect(findLinkingHubRedirect(html, 'https://www-sciencedirect-com.ezproxy.neu.edu/science/article/pii/X')).toBeNull();
    expect(findLinkingHubRedirect(html, 'https://linkinghub.elsevier.com.evil.example/retrieve/pii/X')).toBeNull();
  });

  it('resolves a relative value against ScienceDirect and refuses non-http values', () => {
    const page = (value: string) => `<input type="hidden" name="redirectURL" value="${value}" id="redirectURL"/>`;
    const hub = 'https://linkinghub.elsevier.com/retrieve/pii/X';
    expect(findLinkingHubRedirect(page('%2Fscience%2Farticle%2Fpii%2FX'), hub)).toBe(
      'https://www.sciencedirect.com/science/article/pii/X'
    );
    expect(findLinkingHubRedirect(page('javascript%3Aalert(1)'), hub)).toBeNull();
    expect(findLinkingHubRedirect('<p>Redirecting</p>', hub)).toBeNull();
  });
});

describe('looksLikeAbstractOnly', () => {
  const abstractOnly = readFixture('elsevier-abstract-only.html');
  const withBody = abstractOnly.replace(
    '<section id="da1">',
    `<div id="body" class="Body"><section id="sec1"><h2>1. Introduction</h2><p>${'Synthetic body text. '.repeat(1500)}</p></section></div><section id="da1">`
  );

  it('a ScienceDirect page with an abstract block and no body container is abstract only', () => {
    const text = htmlToText(abstractOnly);
    expect(text.length).toBeGreaterThan(4000);
    expect(looksLikeAbstractOnly(abstractOnly, text)).toBe(true);
  });

  it('the same page with its body container is not abstract only', () => {
    expect(looksLikeAbstractOnly(withBody, htmlToText(withBody))).toBe(false);
  });

  // A short ScienceDirect article (about 6,000 characters), well under the 20,000 cap, so only
  // the div#body check tells it apart from an abstract-only page.
  const shortSdArticle = (withBodyDiv: boolean) => `<html><head>
    <meta name="citation_pii" content="S0000000000000001">
    <meta name="citation_title" content="A synthetic short article">
    <title>A synthetic short article - ScienceDirect</title></head>
    <body><article><div id="abstracts" class="Abstracts"><h2>Abstract</h2>
    <p>${'Invented abstract sentence for a short article. '.repeat(10)}</p></div>
    ${withBodyDiv ? '<div id="body" class="Body">' : '<div class="Other">'}<section><h2>1. Introduction</h2>
    <p>${'Invented body sentence for a short article. '.repeat(120)}</p></section></div></article></body></html>`;

  it('a short ScienceDirect page with its body container is not abstract only', () => {
    const html = shortSdArticle(true);
    const text = htmlToText(html);
    expect(text.length).toBeGreaterThan(4000);
    expect(text.length).toBeLessThan(20_000);
    expect(looksLikeAbstractOnly(html, text)).toBe(false);
    const withoutBody = shortSdArticle(false);
    expect(looksLikeAbstractOnly(withoutBody, htmlToText(withoutBody))).toBe(true);
  });

  const abstractPage = (abstract: string, extra = '') =>
    `<html><body><main><h1>A Title</h1><h2>Abstract</h2><p>${abstract}</p>${extra}</main></body></html>`;

  it('a short generic page that is mostly an Abstract block is abstract only', () => {
    const html = abstractPage('An invented abstract sentence for the generic rule. '.repeat(50), '<p>Cite this article</p>');
    const text = htmlToText(html);
    expect(text.length).toBeGreaterThan(2500);
    expect(text.length).toBeLessThan(4000);
    expect(looksLikeAbstractOnly(html, text)).toBe(true);
  });

  it('a generic page of 4,000 characters or more is not abstract only', () => {
    const html = abstractPage('An invented abstract sentence for the generic rule. '.repeat(80));
    expect(looksLikeAbstractOnly(html, htmlToText(html))).toBe(false);
  });

  it('a short page whose Abstract block is a small part of the text is not abstract only', () => {
    const html = abstractPage('A short invented abstract.', `<h2>Introduction</h2><p>${'Invented body sentence here. '.repeat(100)}</p>`);
    expect(looksLikeAbstractOnly(html, htmlToText(html))).toBe(false);
  });

  it('a short page with no Abstract label is not abstract only', () => {
    const html = `<html><body><main><p>${'Invented landing page text. '.repeat(100)}</p></main></body></html>`;
    expect(looksLikeAbstractOnly(html, htmlToText(html))).toBe(false);
  });
});
