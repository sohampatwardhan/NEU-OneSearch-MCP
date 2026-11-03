import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface PdfExtract {
  text: string;
  pageCount: number;
  pagesExtracted: number;
  title: string | null;
}

interface PdfTextItem {
  str?: string;
}

interface PdfTextContent {
  items: PdfTextItem[];
}

interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: { Title?: unknown } }>;
  destroy(): Promise<void>;
}

interface PdfjsModule {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocument> };
  GlobalWorkerOptions: { workerSrc: string };
}

let pdfjsModule: PdfjsModule | undefined;

function loadPdfjs(): PdfjsModule {
  if (pdfjsModule) return pdfjsModule;
  // Text extraction does not render pages. Stubbing these globals keeps pdf.js
  // from trying to load the optional `canvas` package and warning on stderr.
  const globals = globalThis as unknown as { DOMMatrix?: unknown; Path2D?: unknown };
  if (typeof globals.DOMMatrix === 'undefined') globals.DOMMatrix = class DomMatrixStub {};
  if (typeof globals.Path2D === 'undefined') globals.Path2D = class Path2DStub {};

  const loaded = require('pdfjs-dist/legacy/build/pdf.js') as PdfjsModule;
  loaded.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
  pdfjsModule = loaded;
  return loaded;
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, digits: string) => safeCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i').exec(tag);
  const raw = match?.[2] ?? match?.[3] ?? match?.[4];
  if (!raw) return null;
  return decodeHtmlEntities(raw).trim();
}

export function findMetaContent(html: string, metaName: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = attribute(tag, 'name') ?? attribute(tag, 'property');
    if (name?.toLowerCase() !== metaName.toLowerCase()) continue;
    const content = attribute(tag, 'content');
    if (content) return content;
  }
  return null;
}

function looksLikePdfHref(href: string): boolean {
  return /\.pdf($|[?#])/i.test(href) || /\/pdf($|[/?#])/i.test(href);
}

/** citation_pdf_url, then a link/anchor that points at a PDF. */
export function findPreferredPdfUrl(html: string): string | null {
  const citation = findMetaContent(html, 'citation_pdf_url');
  if (citation) return citation;

  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) {
    const type = attribute(tag, 'type');
    const href = attribute(tag, 'href');
    if (type?.toLowerCase() === 'application/pdf' && href) return href;
  }

  const anchors = html.match(/<a\b[^>]*>/gi) ?? [];
  for (const tag of anchors) {
    const href = attribute(tag, 'href');
    if (href && looksLikePdfHref(href)) return href;
  }
  return null;
}

export function htmlToText(html: string): string {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  let working = article?.[1] ?? main?.[1] ?? html;
  working = working.replace(/<(script|style|noscript|svg|canvas|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  working = working.replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section)\b[^>]*>/gi, '\n');
  working = working.replace(/<[^>]+>/g, ' ');
  working = decodeHtmlEntities(working).replace(/\u00a0/g, ' ');
  working = working
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
  return working.trim();
}

const PAYWALL_RE =
  /purchase this article|buy this article|rent this article|get access to this (article|content)|subscribe to (this )?journal|you do not have access|institution has not subscribed|access through your institution/i;

export function looksLikePaywall(html: string): boolean {
  return PAYWALL_RE.test(html);
}

// Phrases that only appear on an interstitial. Checked in the title and the opening text so
// an article that merely mentions one deep in its body is not misread.
const STRONG_BOT_WALL_RE = new RegExp(
  [
    'Client Challenge',
    "verify that you['\u2019]re not a robot",
    'verify you are (a )?human',
    'Just a moment\\.\\.\\.',
    'Enable JavaScript and cookies to continue',
    'Attention Required! \\| Cloudflare',
    'please complete the captcha',
  ].join('|'),
  'i'
);
// Passive markers that real pages also carry (Cloudflare injects its challenge script into
// ordinary articles). They only count when the page has almost no readable text.
const WEAK_BOT_WALL_RE = /cdn-cgi\/challenge-platform|cf-turnstile|g-recaptcha/i;
const BOT_WALL_OPENING_CHARS = 1000;
const BOT_WALL_MAX_TEXT_CHARS = 1500;

export function looksLikeBotWall(html: string, text: string): boolean {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  // htmlToText drops <noscript>, but challenge pages (IEEE's) put their message only there.
  const noscript = (html.match(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi) ?? []).join(' ').replace(/<[^>]+>/g, ' ');
  if (
    STRONG_BOT_WALL_RE.test(title) ||
    STRONG_BOT_WALL_RE.test(text.slice(0, BOT_WALL_OPENING_CHARS)) ||
    (noscript.length < BOT_WALL_OPENING_CHARS && STRONG_BOT_WALL_RE.test(noscript))
  ) {
    return true;
  }
  return WEAK_BOT_WALL_RE.test(html) && text.length < BOT_WALL_MAX_TEXT_CHARS;
}

const LINKING_HUB_HOSTS = new Set(['linkinghub.elsevier.com', 'linkinghub-elsevier-com.ezproxy.neu.edu']);

/**
 * Elsevier's linkinghub answers a DOI with a "Redirecting" page whose hidden `redirectURL`
 * field holds the ScienceDirect URL, percent-encoded. Returns that URL (http or https only),
 * resolved against ScienceDirect, or null when `pageUrl` is not on linkinghub.
 */
export function findLinkingHubRedirect(html: string, pageUrl: string): string | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!LINKING_HUB_HOSTS.has(host)) return null;

  const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
  const field = inputs.find((tag) => attribute(tag, 'name') === 'redirectURL');
  const raw = field ? attribute(field, 'value') : null;
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  try {
    const url = new URL(decoded, 'https://www.sciencedirect.com');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// ScienceDirect (seen live 2026-11-03): an article page served through the proxy carries the
// abstract in div#abstracts, and the article body, when the page has it, in div#body. Pages
// without div#body hold only the abstract, highlights, keywords and author notes, even for
// entitled open-access articles. Real articles run well past the cap; it guards against
// ScienceDirect renaming its body container and every article reading as abstract-only.
const SCIENCEDIRECT_ABSTRACT_RE = /<(?:div|section)\b[^>]*\bid\s*=\s*["']abstracts["']/i;
const SCIENCEDIRECT_BODY_RE = /<(?:div|section)\b[^>]*\bid\s*=\s*["']body["']/i;
const SCIENCEDIRECT_ABSTRACT_MAX_CHARS = 20_000;
// Any other page: under this length and mostly a block labelled "Abstract".
const GENERIC_ABSTRACT_MAX_CHARS = 4000;
const GENERIC_ABSTRACT_MIN_SHARE = 0.5;
const ABSTRACT_LABEL_RE = /^abstract\s*:?$/i;
const HEADING_MAX_CHARS = 60;

/** Characters in the text block that follows a line reading "Abstract", up to the next heading-like line. */
function abstractBlockChars(text: string): number {
  const lines = text.split('\n').map((line) => line.trim());
  const start = lines.findIndex((line) => ABSTRACT_LABEL_RE.test(line));
  if (start < 0) return 0;
  let chars = 0;
  for (const line of lines.slice(start + 1)) {
    if (!line) continue;
    const headingLike = line.length <= HEADING_MAX_CHARS && !/[.!?]$/.test(line);
    if (headingLike && chars > 0) break;
    chars += line.length;
  }
  return chars;
}

/**
 * True when the page shows an abstract (and metadata) but not the article body.
 * ScienceDirect: an abstract container with no body container. Elsewhere: text under
 * 4,000 characters, at least half of it the block labelled "Abstract".
 */
export function looksLikeAbstractOnly(html: string, text: string): boolean {
  if (
    findMetaContent(html, 'citation_pii') &&
    SCIENCEDIRECT_ABSTRACT_RE.test(html) &&
    !SCIENCEDIRECT_BODY_RE.test(html) &&
    text.length < SCIENCEDIRECT_ABSTRACT_MAX_CHARS
  ) {
    return true;
  }
  if (text.length === 0 || text.length >= GENERIC_ABSTRACT_MAX_CHARS) return false;
  return abstractBlockChars(text) >= text.length * GENERIC_ABSTRACT_MIN_SHARE;
}

export function looksLikeHtml(bytes: Uint8Array, contentType: string): boolean {
  const type = contentType.toLowerCase();
  if (type.includes('html') || type.includes('xml') || type.startsWith('text/')) return true;
  if (type && !type.includes('octet-stream')) return false;
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml');
}

export function looksLikePdf(bytes: Uint8Array, contentType: string): boolean {
  if (contentType.toLowerCase().includes('application/pdf')) return true;
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const match = /charset=([^;]+)/i.exec(contentType);
  const charset = match?.[1]?.trim().replace(/['"]/g, '') || 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function extractPdfText(bytes: Uint8Array, maxPages: number): Promise<PdfExtract> {
  const pdfjs = loadPdfjs();
  const document = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;

  try {
    const pageCount = document.numPages;
    const pagesExtracted = Math.min(pageCount, Math.max(0, maxPages));
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pagesExtracted; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => item.str ?? '')
        .join(' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      if (line) pages.push(line);
    }

    let title: string | null = null;
    try {
      const metadata = await document.getMetadata();
      const rawTitle = metadata.info?.Title;
      if (typeof rawTitle === 'string' && rawTitle.trim()) title = rawTitle.trim();
    } catch {
      title = null;
    }

    return { text: pages.join('\n\n'), pageCount, pagesExtracted, title };
  } finally {
    await document.destroy();
  }
}
