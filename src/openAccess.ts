import { fetchPublicResource, FULL_TEXT_LIMITS, type FetchLike, type LookupLike } from './ezproxy.js';
import { extractPdfText, looksLikePdf } from './extractText.js';
import { emptyResult, type CopyVersion, type FullTextResult } from './fullTextResult.js';
import type { Deadline } from './deadline.js';

/** One open-access PDF location OpenAlex lists for a work. */
export interface OaCopy {
  pdfUrl: string;
  version: CopyVersion;
  /** The repository or journal hosting the copy, when OpenAlex names one. */
  repository: string | null;
}

/** The fallback is skipped when less time than this remains of the overall deadline. */
export const MIN_OPEN_ACCESS_MS = 10_000;
/** At most this many copies are fetched per call. */
export const MAX_OPEN_ACCESS_COPIES = 3;

const OPENALEX_WORKS = 'https://api.openalex.org/works/doi:';
/** An OpenAlex work record is tens of kilobytes; anything far larger is not one. */
const MAX_OPENALEX_CHARS = 5 * 1024 * 1024;

const VERSION_ORDER: CopyVersion[] = ['published', 'accepted', 'submitted', 'unknown'];

function toVersion(value: unknown): CopyVersion {
  switch (value) {
    case 'publishedVersion':
      return 'published';
    case 'acceptedVersion':
      return 'accepted';
    case 'submittedVersion':
      return 'submitted';
    default:
      return 'unknown';
  }
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function copiesFromWork(work: unknown): OaCopy[] | null {
  if (!work || typeof work !== 'object') return null;
  const locations = (work as { locations?: unknown }).locations;
  if (!Array.isArray(locations)) return null;

  const copies: OaCopy[] = [];
  for (const location of locations) {
    if (!location || typeof location !== 'object') continue;
    const entry = location as { pdf_url?: unknown; version?: unknown; source?: { display_name?: unknown } | null };
    const pdfUrl = httpUrl(entry.pdf_url);
    if (!pdfUrl) continue;
    const name = entry.source?.display_name;
    copies.push({
      pdfUrl,
      version: toVersion(entry.version),
      repository: typeof name === 'string' && name.trim() ? name.trim() : null,
    });
  }

  // Array.prototype.sort is stable, so OpenAlex's own order holds within a version.
  copies.sort((a, b) => VERSION_ORDER.indexOf(a.version) - VERSION_ORDER.indexOf(b.version));
  const seen = new Set<string>();
  return copies.filter((copy) => (seen.has(copy.pdfUrl) ? false : (seen.add(copy.pdfUrl), true)));
}

/** The copies ([] when OpenAlex has no such work), or null when OpenAlex could not be asked or answered badly. */
async function lookupCopies(doi: string, fetchImpl: FetchLike, timeoutMs: number): Promise<OaCopy[] | null> {
  try {
    // Keyless and without mailto (the owner has not opted in). No cookie is ever attached.
    const response = await fetchImpl(`${OPENALEX_WORKS}${encodeURIComponent(doi)}`, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    if (!response) return null;
    // A 404 is OpenAlex's answer that it has no work for this DOI: a search with no copies.
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return [];
    }
    if (!response.ok) return null;
    const body = await response.text();
    if (body.length > MAX_OPENALEX_CHARS) return null;
    return copiesFromWork(JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * Open-access PDF copies of a work, published first, then accepted, submitted and unknown,
 * deduped by URL. Never throws: any HTTP, network or parse problem gives `[]`.
 */
export async function findOpenAccessCopies(doi: string, fetchImpl: FetchLike = fetch): Promise<OaCopy[]> {
  return (await lookupCopies(doi, fetchImpl, FULL_TEXT_LIMITS.timeoutMs)) ?? [];
}

export interface TryOpenAccessOptions {
  /** The host that just blocked or refused us; its copies are not tried. */
  skipHost: string | null;
  deadline: Deadline;
  /** Transport for the copies. Defaults to the address-pinned fetch in `fetchPublicResource`. */
  fetchImpl?: FetchLike;
  /** Transport for the OpenAlex lookup. Defaults to the global `fetch`. */
  openAlexFetch?: FetchLike;
  lookupImpl?: LookupLike;
  maxPdfPages: number;
  maxTextChars: number;
  maxDownloadBytes?: number;
  maxRedirects?: number;
  /** Per-request cap; each request is also capped by what remains of `deadline`. */
  timeoutMs?: number;
}

export type OpenAccessOutcome =
  | { copy: OaCopy; result: FullTextResult }
  | {
      copy: null;
      /** Copies fetched (refused hosts included; the skipped host is not). */
      tried: number;
      /** The first copy that answered but gave no text: an HTML page, a PDF without text, or one too large. */
      firstUnextractable: OaCopy | null;
      /** True when no copy could be tried because OpenAlex failed or time ran short. */
      skipped: boolean;
    };

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function versionNote(version: CopyVersion): string {
  switch (version) {
    case 'published':
      return 'It is the published version.';
    case 'accepted':
      return 'It is the accepted manuscript (after peer review), not the published version, so wording and page numbers may differ from the journal article.';
    case 'submitted':
      return 'It is the submitted version (a preprint, before peer review), not the published version, so it may differ from the journal article.';
    case 'unknown':
      return 'OpenAlex does not say which version it is, so it may not be the published version.';
  }
}

async function resultFromCopy(
  copy: OaCopy,
  doi: string,
  bytes: Uint8Array,
  contentType: string,
  sourceUrl: string,
  opts: TryOpenAccessOptions
): Promise<FullTextResult | null> {
  let extracted;
  try {
    extracted = await extractPdfText(bytes, opts.maxPdfPages);
  } catch {
    return null;
  }
  const text = extracted.text.length > opts.maxTextChars ? extracted.text.slice(0, opts.maxTextChars) : extracted.text;
  if (!text) return null;
  const clipped = text.length < extracted.text.length;

  const where = copy.repository ?? hostOf(sourceUrl) ?? 'an open-access repository';
  const notes = [
    `The text comes from an open-access copy at ${where}, found through OpenAlex and fetched without the library session.`,
    versionNote(copy.version),
    'Extracted plain text from the PDF. This is text for synthesis, not the original file.',
  ];
  if (text.length < 200) {
    notes.push('Very little text was extracted; the PDF may be scanned images or only a cover page.');
  }
  if (extracted.pagesExtracted < extracted.pageCount) {
    notes.push(`Stopped after ${extracted.pagesExtracted} of ${extracted.pageCount} pages (page cap ${opts.maxPdfPages}).`);
  }
  if (clipped) notes.push(`Text was truncated to ${opts.maxTextChars} characters.`);

  return emptyResult({
    status: 'ok',
    version: copy.version,
    doi,
    title: extracted.title,
    sourceUrl,
    contentType,
    via: 'pdf',
    pageCount: extracted.pageCount,
    pagesExtracted: extracted.pagesExtracted,
    truncated: clipped || extracted.pagesExtracted < extracted.pageCount,
    charCount: text.length,
    text,
    message: notes.join(' '),
  });
}

/**
 * Look the DOI up in OpenAlex and try up to three of its open-access PDFs, in version
 * order, until one extracts text. Copies are fetched with `fetchPublicResource` (no
 * cookies, public addresses only). A copy that answers with HTML, a bot check or an error
 * is skipped, never retried with other headers. Stops when less than 10 s remain.
 */
export async function tryOpenAccess(doi: string, opts: TryOpenAccessOptions): Promise<OpenAccessOutcome> {
  const perRequestMs = opts.timeoutMs ?? FULL_TEXT_LIMITS.timeoutMs;
  const timeLeft = () => opts.deadline.remainingMs() >= MIN_OPEN_ACCESS_MS;
  if (!timeLeft()) return { copy: null, tried: 0, firstUnextractable: null, skipped: true };

  const copies = await lookupCopies(
    doi,
    opts.openAlexFetch ?? fetch,
    Math.min(perRequestMs, opts.deadline.remainingMs())
  );
  if (copies === null) return { copy: null, tried: 0, firstUnextractable: null, skipped: true };

  const skipHost = opts.skipHost?.toLowerCase() ?? null;
  const candidates = copies.filter((copy) => !skipHost || hostOf(copy.pdfUrl) !== skipHost);
  let tried = 0;
  let firstUnextractable: OaCopy | null = null;
  for (const copy of candidates) {
    if (tried >= MAX_OPEN_ACCESS_COPIES) break;
    if (!timeLeft()) {
      if (tried === 0) return { copy: null, tried, firstUnextractable, skipped: true };
      break;
    }
    tried++;
    const fetched = await fetchPublicResource(copy.pdfUrl, {
      fetchImpl: opts.fetchImpl,
      lookupImpl: opts.lookupImpl,
      maxDownloadBytes: opts.maxDownloadBytes,
      maxRedirects: opts.maxRedirects,
      timeoutMs: Math.min(perRequestMs, opts.deadline.remainingMs()),
    });
    if (fetched.kind === 'too_large') {
      firstUnextractable ??= copy;
      continue;
    }
    if (fetched.kind !== 'response' || fetched.httpStatus >= 400) continue;
    if (looksLikePdf(fetched.body, fetched.contentType)) {
      const result = await resultFromCopy(copy, doi, fetched.body, fetched.contentType, fetched.finalUrl, opts);
      if (result) return { copy, result };
    }
    firstUnextractable ??= copy;
  }
  return { copy: null, tried, firstUnextractable, skipped: false };
}
