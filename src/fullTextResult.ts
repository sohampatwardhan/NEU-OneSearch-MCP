import { FULL_TEXT_LIMITS } from './ezproxy.js';

export type FullTextStatus =
  | 'ok'
  | 'partial'
  | 'login_required'
  | 'not_proxied'
  | 'not_entitled'
  | 'not_found'
  | 'too_large'
  | 'unsupported'
  | 'blocked'
  | 'error';

/** What the returned text is: the article body, only an abstract, or not known. */
export type TextKind = 'article' | 'abstract' | 'unknown';

/** Which copy of the work the text came from. */
export type CopyVersion = 'published' | 'accepted' | 'submitted' | 'unknown';

export interface FullTextResult {
  status: FullTextStatus;
  /** True only when `status` is `ok`: the text is the article body. */
  fullText: boolean;
  /** Where a person can open the article in a browser when full text was not retrieved. */
  readUrl: string | null;
  textKind: TextKind | null;
  version: CopyVersion | null;
  doi: string | null;
  recordId: string | null;
  title: string | null;
  sourceUrl: string | null;
  contentType: string | null;
  via: 'pdf' | 'html' | null;
  pageCount: number | null;
  pagesExtracted: number | null;
  truncated: boolean;
  charCount: number;
  text: string | null;
  message: string;
  limits: {
    maxDownloadBytes: number;
    maxTextChars: number;
    maxPdfPages: number;
  };
}

export const LIMITS_VIEW = {
  maxDownloadBytes: FULL_TEXT_LIMITS.maxDownloadBytes,
  maxTextChars: FULL_TEXT_LIMITS.maxTextChars,
  maxPdfPages: FULL_TEXT_LIMITS.maxPdfPages,
};

export function emptyResult(
  overrides: Partial<FullTextResult> & Pick<FullTextResult, 'status' | 'message'>
): FullTextResult {
  return {
    fullText: false,
    readUrl: null,
    textKind: null,
    version: null,
    doi: null,
    recordId: null,
    title: null,
    sourceUrl: null,
    contentType: null,
    via: null,
    pageCount: null,
    pagesExtracted: null,
    truncated: false,
    charCount: 0,
    text: null,
    limits: LIMITS_VIEW,
    ...overrides,
  };
}

const PLAIN_PREFIX = 'Full text was not retrieved: ';
const ABSTRACT_PREFIX = 'Abstract only. Full text was not retrieved: ';

/**
 * The single place the fullText / readUrl / textKind / message-prefix rules live.
 * Pure and idempotent: finalizing twice gives the same result.
 */
export function finalizeResult(result: FullTextResult, readUrl: string | null): FullTextResult {
  const out: FullTextResult = { ...result };
  out.fullText = out.status === 'ok';
  if (out.status === 'ok') out.textKind = 'article';
  else if (out.status === 'partial' && out.textKind === null) out.textKind = 'unknown';
  if (out.fullText) return out;

  if (out.readUrl === null) out.readUrl = readUrl;
  const prefix = out.textKind === 'abstract' ? ABSTRACT_PREFIX : PLAIN_PREFIX;
  let message = out.message;
  if (!message.startsWith(PLAIN_PREFIX) && !message.startsWith(ABSTRACT_PREFIX)) message = prefix + message;
  if (out.readUrl) {
    const suffix = ` Open it in a browser: ${out.readUrl}`;
    if (!message.endsWith(suffix)) message += suffix;
  }
  out.message = message;
  return out;
}
