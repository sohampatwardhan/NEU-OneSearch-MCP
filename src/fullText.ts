import { getRecord } from './primoClient.js';
import { mapDoc } from './mapper.js';
import {
  buildEzproxyDoiUrl,
  fetchEzproxyResource,
  fetchPublicResource,
  FULL_TEXT_LIMITS,
  isEzproxyLoginPage,
  isEzproxyMenuPage,
  normalizeDoi,
  toEzproxyFetchUrl,
  type FetchLike,
  type LookupLike,
  type ProxyFetchResult,
} from './ezproxy.js';
import {
  decodeBody,
  extractPdfText,
  findMetaContent,
  findPreferredPdfUrl,
  htmlToText,
  looksLikeBotWall,
  looksLikeHtml,
  looksLikePaywall,
  looksLikePdf,
} from './extractText.js';
import { classifyEzproxySession, loadStoredCookies, type EzproxySessionState } from './session.js';
import { sessionCachePath } from './cache.js';
import type { MappedResult } from './types.js';

export type FullTextStatus =
  | 'ok'
  | 'partial'
  | 'login_required'
  | 'not_proxied'
  | 'not_entitled'
  | 'not_found'
  | 'too_large'
  | 'unsupported'
  | 'error';

export interface FullTextResult {
  status: FullTextStatus;
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

export interface GetFullTextInput {
  doi?: string;
  recordId?: string;
}

export interface GetFullTextOptions {
  fetchImpl?: FetchLike;
  lookupImpl?: LookupLike;
  sessionPath?: string;
  nowMs?: number;
  maxDownloadBytes?: number;
  maxTextChars?: number;
  maxPdfPages?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

interface ResolvedTarget {
  doi: string | null;
  recordId: string | null;
  title: string | null;
  startUrl: string;
}

/** How the article bytes were reached: through EZproxy with the session, or directly without it. */
type FetchRoute = 'proxy' | 'direct';

const DIRECT_NOTE =
  "This publisher is not on NEU's EZproxy (it is likely open access), so the article was fetched directly from the publisher without the library session.";

const LIMITS_VIEW = {
  maxDownloadBytes: FULL_TEXT_LIMITS.maxDownloadBytes,
  maxTextChars: FULL_TEXT_LIMITS.maxTextChars,
  maxPdfPages: FULL_TEXT_LIMITS.maxPdfPages,
};

function emptyResult(overrides: Partial<FullTextResult> & Pick<FullTextResult, 'status' | 'message'>): FullTextResult {
  return {
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

function sessionLocationPhrase(): string {
  return process.env.NEU_ONESEARCH_CACHE_DIR?.trim()
    ? 'the cache directory named by NEU_ONESEARCH_CACHE_DIR'
    : 'the cached session (~/.cache/neu-onesearch-mcp/session.json)';
}

function loginMessage(state: Exclude<EzproxySessionState, 'ready'>): string {
  const where = sessionLocationPhrase();
  switch (state) {
    case 'absent':
      return `No NEU session found at ${where}. Run \`neu-onesearch-login\` (or \`node dist/login.js\` after \`npm run build\`), complete NU IT sign-in in the browser, and finish the EZproxy step. Then call get_full_text again. search_onesearch and get_record keep working without a session. Your password is never entered into this server.`;
    case 'expired':
      return `The EZproxy cookie in ${where} is expired. Re-run \`neu-onesearch-login\` and finish the library proxy sign-in. Search metadata is unaffected.`;
    case 'onesearch_only':
      return `The session has OneSearch cookies but no EZproxy cookie. OneSearch login alone does not unlock article full text. Re-run \`neu-onesearch-login\` and complete the EZproxy / NU IT step.`;
    case 'unusable':
      return `The session at ${where} has no usable EZproxy cookie. Re-run \`neu-onesearch-login\` and finish the library proxy sign-in.`;
  }
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function resolveHttpUrl(value: string, baseUrl: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /^(javascript|data):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function targetFromMapped(mapped: MappedResult, recordId: string): ResolvedTarget | FullTextResult {
  if (mapped.doi) {
    const startUrl = buildEzproxyDoiUrl(mapped.doi);
    if (startUrl) {
      return { doi: mapped.doi, recordId, title: mapped.title, startUrl };
    }
  }
  const candidate = mapped.fullTextUrl ?? mapped.ezproxyDoiUrl;
  if (candidate) {
    const startUrl = toEzproxyFetchUrl(candidate);
    if (startUrl) {
      return { doi: mapped.doi, recordId, title: mapped.title, startUrl };
    }
  }
  return emptyResult({
    status: 'unsupported',
    recordId,
    title: mapped.title,
    doi: mapped.doi,
    message: 'This catalog record has no DOI or EZproxy full-text link to retrieve.',
  });
}

async function resolveTarget(input: GetFullTextInput): Promise<ResolvedTarget | FullTextResult> {
  const doi = input.doi?.trim() || undefined;
  const recordId = input.recordId?.trim() || undefined;
  if (!doi && !recordId) {
    return emptyResult({
      status: 'error',
      message: 'Provide a doi from search_onesearch (preferred, including CDI articles) or an alma recordId.',
    });
  }

  if (doi) {
    const normalized = normalizeDoi(doi);
    const startUrl = normalized ? buildEzproxyDoiUrl(normalized) : null;
    if (!normalized || !startUrl) {
      return emptyResult({
        status: 'error',
        doi,
        recordId: recordId ?? null,
        message: 'That doi is not a usable DOI. Pass the DOI itself or a https://doi.org/ URL.',
      });
    }
    return { doi: normalized, recordId: recordId ?? null, title: null, startUrl };
  }

  try {
    const doc = await getRecord(recordId!);
    if (!doc) {
      return emptyResult({
        status: 'not_found',
        recordId: recordId ?? null,
        message: `No catalog record found for id: ${recordId}`,
      });
    }
    return targetFromMapped(mapDoc(doc), recordId!);
  } catch (err) {
    return emptyResult({
      status: 'error',
      recordId: recordId ?? null,
      message: err instanceof Error ? err.message : 'Could not load that catalog record.',
    });
  }
}

async function textFromPdf(
  bytes: Uint8Array,
  contentType: string,
  sourceUrl: string,
  base: ResolvedTarget,
  options: GetFullTextOptions,
  route: FetchRoute = 'proxy'
): Promise<FullTextResult> {
  const maxPages = options.maxPdfPages ?? FULL_TEXT_LIMITS.maxPdfPages;
  const maxChars = options.maxTextChars ?? FULL_TEXT_LIMITS.maxTextChars;
  let extracted;
  try {
    extracted = await extractPdfText(bytes, maxPages);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'unknown error';
    return emptyResult({
      status: 'unsupported',
      doi: base.doi,
      recordId: base.recordId,
      title: base.title,
      sourceUrl,
      contentType,
      via: 'pdf',
      message: `The response was a PDF but its text could not be extracted (${detail}). Encrypted or image-only PDFs are not supported.`,
    });
  }

  const clipped = clip(extracted.text, maxChars);
  const truncated = clipped.truncated || extracted.pagesExtracted < extracted.pageCount;
  if (!clipped.text) {
    return emptyResult({
      status: 'unsupported',
      doi: base.doi,
      recordId: base.recordId,
      title: base.title ?? extracted.title,
      sourceUrl,
      contentType,
      via: 'pdf',
      pageCount: extracted.pageCount,
      pagesExtracted: extracted.pagesExtracted,
      truncated,
      message:
        'The PDF had no extractable text layer. It is likely a scan, a cover image, or DRM-restricted. This tool does not OCR.',
    });
  }

  const notes =
    route === 'proxy'
      ? ['Extracted plain text from a PDF served through NEU EZproxy. This is text for synthesis, not the original file.']
      : [DIRECT_NOTE, 'Extracted plain text from the PDF. This is text for synthesis, not the original file.'];
  if (clipped.text.length < 200) {
    notes.push('Very little text was extracted; the PDF may be scanned images or only a cover page.');
  }
  if (extracted.pagesExtracted < extracted.pageCount) {
    notes.push(`Stopped after ${extracted.pagesExtracted} of ${extracted.pageCount} pages (page cap ${maxPages}).`);
  }
  if (clipped.truncated) {
    notes.push(`Text was truncated to ${maxChars} characters.`);
  }

  return emptyResult({
    status: 'ok',
    doi: base.doi,
    recordId: base.recordId,
    title: base.title ?? extracted.title,
    sourceUrl,
    contentType,
    via: 'pdf',
    pageCount: extracted.pageCount,
    pagesExtracted: extracted.pagesExtracted,
    truncated,
    charCount: clipped.text.length,
    text: clipped.text,
    message: notes.join(' '),
  });
}

function textFromHtml(
  html: string,
  contentType: string,
  sourceUrl: string,
  base: ResolvedTarget,
  maxChars: number,
  route: FetchRoute = 'proxy'
): FullTextResult {
  const text = htmlToText(html);
  const title = findMetaContent(html, 'citation_title') ?? base.title;
  const routed = (message: string) => (route === 'direct' ? `${DIRECT_NOTE} ${message}` : message);
  if (looksLikeBotWall(html, text)) {
    return emptyResult({
      status: 'unsupported',
      doi: base.doi,
      recordId: base.recordId,
      title,
      sourceUrl,
      contentType,
      via: 'html',
      message: routed(
        'The publisher or proxy returned a bot check or CAPTCHA instead of the article. Open the source URL in a browser while signed in. This server does not solve CAPTCHAs.'
      ),
    });
  }

  const clipped = clip(text, maxChars);
  const paywall = looksLikePaywall(html);
  let status: FullTextStatus;
  let message: string;
  if (paywall && text.length < 8000) {
    status = 'not_entitled';
    message =
      'The proxied page looks like a publisher access wall. NEU may not subscribe, or the publisher refused this client. Any text is what was visible without the article body (often an abstract), not the full text.';
  } else if (paywall) {
    status = 'partial';
    message =
      'The HTML page contains access-wall language and no separate PDF was downloaded. The text may mix the article with subscription prompts. Treat it as incomplete.';
  } else if (text.length >= 2500) {
    status = 'ok';
    message =
      `No PDF link was found. Text was extracted from the HTML page${route === 'proxy' ? ' through EZproxy' : ''} and may include site navigation along with the article.`;
  } else if (text.length > 0) {
    status = 'partial';
    message =
      'No PDF link was found, and the HTML text is short. It may be an abstract or landing page rather than the article body.';
  } else {
    status = 'unsupported';
    message =
      'The proxied page returned HTML with no extractable text. The publisher may render the article only in the browser. JavaScript-only pages, DRM, and CAPTCHAs are not supported.';
  }

  if (clipped.truncated) {
    message += ` Text was truncated to ${maxChars} characters.`;
  }

  return emptyResult({
    status,
    doi: base.doi,
    recordId: base.recordId,
    title,
    sourceUrl,
    contentType,
    via: 'html',
    truncated: clipped.truncated,
    charCount: clipped.text.length,
    text: clipped.text || null,
    message: routed(message),
  });
}

/** The publisher is off the proxy and its text could not be fetched directly: point at its URL. */
function notProxied(base: ResolvedTarget, publisherUrl: string, reason: string): FullTextResult {
  return emptyResult({
    status: 'not_proxied',
    doi: base.doi,
    recordId: base.recordId,
    title: base.title,
    sourceUrl: publisherUrl,
    message: `${reason} The article is at ${publisherUrl}. Open that URL directly; signing in again will not help.`,
  });
}

/**
 * EZproxy passed the target through unproxied, so fetch it straight from the publisher
 * with no session cookie. Any failure falls back to `not_proxied` with the publisher URL.
 */
async function fullTextDirect(
  offProxy: Extract<ProxyFetchResult, { kind: 'off_proxy' }>,
  target: ResolvedTarget,
  options: GetFullTextOptions
): Promise<FullTextResult> {
  const publisherUrl = offProxy.offProxyUrl;
  const fetched = await fetchPublicResource(publisherUrl, options);
  if (fetched.kind === 'too_large') return failureFromProxy(fetched, target);
  if (fetched.kind !== 'response') {
    return notProxied(target, publisherUrl, `${offProxy.message} A direct fetch failed: ${fetched.message}`);
  }
  if (fetched.httpStatus >= 400) {
    return notProxied(
      target,
      publisherUrl,
      `${offProxy.message} A direct fetch returned HTTP ${fetched.httpStatus}, so the article may not be open access.`
    );
  }

  if (looksLikePdf(fetched.body, fetched.contentType)) {
    return textFromPdf(fetched.body, fetched.contentType, fetched.finalUrl, target, options, 'direct');
  }
  if (!looksLikeHtml(fetched.body, fetched.contentType)) {
    return notProxied(
      target,
      publisherUrl,
      `${offProxy.message} The publisher returned ${fetched.contentType || 'an unknown content type'}, which is neither HTML nor PDF.`
    );
  }

  const html = decodeBody(fetched.body, fetched.contentType);
  const htmlTitle = findMetaContent(html, 'citation_title');
  const titledTarget = htmlTitle ? { ...target, title: htmlTitle } : target;
  const pdfHref = findPreferredPdfUrl(html);
  const absolutePdf = pdfHref ? resolveHttpUrl(pdfHref, fetched.finalUrl) : null;
  if (absolutePdf && absolutePdf !== fetched.finalUrl) {
    const pdfResponse = await fetchPublicResource(absolutePdf, options);
    if (
      pdfResponse.kind === 'response' &&
      pdfResponse.httpStatus < 400 &&
      looksLikePdf(pdfResponse.body, pdfResponse.contentType)
    ) {
      return textFromPdf(pdfResponse.body, pdfResponse.contentType, pdfResponse.finalUrl, titledTarget, options, 'direct');
    }
    if (pdfResponse.kind === 'too_large') return failureFromProxy(pdfResponse, titledTarget);
  }

  return textFromHtml(
    html,
    fetched.contentType,
    fetched.finalUrl,
    titledTarget,
    options.maxTextChars ?? FULL_TEXT_LIMITS.maxTextChars,
    'direct'
  );
}

function failureFromProxy(
  result: Exclude<ProxyFetchResult, { kind: 'response' }>,
  base: ResolvedTarget
): FullTextResult {
  if (result.kind === 'login_required') {
    return emptyResult({
      status: 'login_required',
      doi: base.doi,
      recordId: base.recordId,
      title: base.title,
      sourceUrl: base.startUrl,
      message: result.message,
    });
  }
  if (result.kind === 'off_proxy') {
    return notProxied(base, result.offProxyUrl, result.message);
  }
  if (result.kind === 'too_large') {
    return emptyResult({
      status: 'too_large',
      doi: base.doi,
      recordId: base.recordId,
      title: base.title,
      sourceUrl: result.finalUrl,
      message: result.message,
    });
  }
  return emptyResult({
    status: 'error',
    doi: base.doi,
    recordId: base.recordId,
    title: base.title,
    sourceUrl: result.finalUrl ?? base.startUrl,
    message: result.message,
  });
}

function httpFailure(response: Extract<ProxyFetchResult, { kind: 'response' }>, base: ResolvedTarget): FullTextResult | null {
  if (response.httpStatus === 401 || response.httpStatus === 403) {
    const html = response.contentType.toLowerCase().includes('html')
      ? decodeBody(response.body, response.contentType)
      : '';
    const text = html ? clip(htmlToText(html), 2000).text : null;
    return emptyResult({
      status: 'not_entitled',
      doi: base.doi,
      recordId: base.recordId,
      title: base.title,
      sourceUrl: response.finalUrl,
      contentType: response.contentType || null,
      via: html ? 'html' : null,
      charCount: text?.length ?? 0,
      text,
      message: `The proxy or publisher returned HTTP ${response.httpStatus}. The signed-in library session could not retrieve this item. It may be outside NEU's subscriptions, or the publisher blocked the download.`,
    });
  }
  if (response.httpStatus === 404) {
    return emptyResult({
      status: 'not_found',
      doi: base.doi,
      recordId: base.recordId,
      title: base.title,
      sourceUrl: response.finalUrl,
      contentType: response.contentType || null,
      message: 'The proxied URL returned HTTP 404.',
    });
  }
  if (response.httpStatus >= 400) {
    return emptyResult({
      status: 'error',
      doi: base.doi,
      recordId: base.recordId,
      title: base.title,
      sourceUrl: response.finalUrl,
      contentType: response.contentType || null,
      message: `The library proxy returned HTTP ${response.httpStatus}.`,
    });
  }
  return null;
}

export async function getFullText(input: GetFullTextInput, options: GetFullTextOptions = {}): Promise<FullTextResult> {
  const target = await resolveTarget(input);
  if ('status' in target) return target;

  const sessionPath = options.sessionPath ?? sessionCachePath();
  const cookies = loadStoredCookies(sessionPath);
  const sessionState = classifyEzproxySession(cookies, options.nowMs);
  if (sessionState !== 'ready' || !cookies) {
    return emptyResult({
      status: 'login_required',
      doi: target.doi,
      recordId: target.recordId,
      title: target.title,
      sourceUrl: target.startUrl,
      message: loginMessage(sessionState === 'ready' ? 'unusable' : sessionState),
    });
  }

  const fetched = await fetchEzproxyResource(target.startUrl, cookies, options);
  if (fetched.kind === 'off_proxy') return fullTextDirect(fetched, target, options);
  if (fetched.kind !== 'response') return failureFromProxy(fetched, target);

  const httpError = httpFailure(fetched, target);
  if (httpError) return httpError;

  if (looksLikePdf(fetched.body, fetched.contentType)) {
    return textFromPdf(fetched.body, fetched.contentType, fetched.finalUrl, target, options);
  }

  if (!looksLikeHtml(fetched.body, fetched.contentType)) {
    return emptyResult({
      status: 'unsupported',
      doi: target.doi,
      recordId: target.recordId,
      title: target.title,
      sourceUrl: fetched.finalUrl,
      contentType: fetched.contentType || null,
      message: `The proxy returned ${fetched.contentType || 'an unknown content type'}, which is neither HTML nor PDF. Binary files are not returned.`,
    });
  }

  const html = decodeBody(fetched.body, fetched.contentType);
  if (isEzproxyMenuPage(fetched.finalUrl)) {
    return emptyResult({
      status: 'error',
      doi: target.doi,
      recordId: target.recordId,
      title: target.title,
      sourceUrl: target.startUrl,
      message:
        'EZproxy accepted the session but did not open the target and showed its database menu instead. The start URL was not accepted by the proxy. Signing in again will not help. No article text was retrieved.',
    });
  }
  if (isEzproxyLoginPage(fetched.finalUrl, html)) {
    return emptyResult({
      status: 'login_required',
      doi: target.doi,
      recordId: target.recordId,
      title: target.title,
      sourceUrl: target.startUrl,
      message:
        'EZproxy showed the NU IT sign-in page. The saved session is missing, expired, or was not accepted. Re-run `neu-onesearch-login` and finish the EZproxy step. No article text was retrieved.',
    });
  }

  const htmlTitle = findMetaContent(html, 'citation_title');
  const titledTarget = htmlTitle ? { ...target, title: htmlTitle } : target;
  const pdfHref = findPreferredPdfUrl(html);
  const absolutePdf = pdfHref ? resolveHttpUrl(pdfHref, fetched.finalUrl) : null;
  const proxiedPdf = absolutePdf ? toEzproxyFetchUrl(absolutePdf) : null;
  if (proxiedPdf && proxiedPdf !== fetched.finalUrl) {
    const pdfResponse = await fetchEzproxyResource(proxiedPdf, fetched.cookies, options);
    if (pdfResponse.kind === 'response') {
      const pdfHttpError = httpFailure(pdfResponse, titledTarget);
      if (!pdfHttpError && looksLikePdf(pdfResponse.body, pdfResponse.contentType)) {
        return textFromPdf(pdfResponse.body, pdfResponse.contentType, pdfResponse.finalUrl, titledTarget, options);
      }
      if (pdfHttpError?.status === 'not_entitled') return pdfHttpError;
    } else if (pdfResponse.kind === 'too_large') {
      return failureFromProxy(pdfResponse, titledTarget);
    }
  }

  return textFromHtml(
    html,
    fetched.contentType,
    fetched.finalUrl,
    titledTarget,
    options.maxTextChars ?? FULL_TEXT_LIMITS.maxTextChars
  );
}

export { FULL_TEXT_LIMITS };
