/**
 * EZproxy URL helpers and the full-text fetch path. The login CLI navigates to a
 * proxied article so EZproxy sets its session cookie after NU IT sign-in; the
 * `get_full_text` tool reuses the DOI/URL helpers and `fetchEzproxyResource` to
 * pull the proxied article. Cookie scoping comes from `session.ts` (#5), which
 * is the single source of truth for which cookies reach which host.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isSignInHostname } from './auth.js';
import { cookieHeaderForHost, isEzproxyHostname, type StoredCookie } from './session.js';

/** Canonical NEU library prefix. Primo `linktorsrc` links and the library bookmarklet use this host. */
export const EZPROXY_LOGIN_ORIGIN = 'https://link.ezproxy.neu.edu';

/**
 * Open-access PLOS ONE article. Login only navigates here so EZproxy will set a
 * session cookie after NU IT sign-in. The article itself is not special.
 */
export const EZPROXY_PROBE_DOI = '10.1371/journal.pone.0212767';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Caps applied to a full-text fetch so one call cannot exhaust memory or hang. */
export const FULL_TEXT_LIMITS = {
  maxDownloadBytes: 20 * 1024 * 1024,
  maxTextChars: 100_000,
  maxPdfPages: 40,
  maxRedirects: 8,
  timeoutMs: 20_000,
} as const;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Resolve a hostname to its IP addresses. Injected in tests so they make no DNS queries. */
export type LookupLike = (hostname: string) => Promise<string[]>;

export interface ProxyFetchOptions {
  fetchImpl?: FetchLike;
  lookupImpl?: LookupLike;
  maxDownloadBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  nowMs?: number;
}

export type ProxyFetchResult =
  | {
      kind: 'response';
      finalUrl: string;
      httpStatus: number;
      contentType: string;
      body: Uint8Array;
      /** Cookie jar after this chain, including Set-Cookie values from EZproxy hops. */
      cookies: StoredCookie[];
      /** Redirects followed to reach `finalUrl`, so a caller can keep a later hop inside `maxRedirects`. */
      redirects: number;
    }
  | { kind: 'login_required'; finalUrl: string; message: string }
  /** EZproxy handed the target back unproxied: the publisher is not on NEU's proxy. */
  | { kind: 'off_proxy'; finalUrl: string; offProxyUrl: string; message: string }
  | { kind: 'too_large'; finalUrl: string; message: string }
  | { kind: 'error'; finalUrl: string | null; message: string };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeDoi(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  value = value.replace(/^doi:\s*/i, '');

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'doi.org' && host !== 'dx.doi.org') return null;
    value = safeDecode(url.pathname.replace(/^\//, ''));
  }

  value = value.trim();
  if (!/^10\.\d{4,9}\/\S+$/i.test(value)) return null;
  if (/[\s<>]/.test(value)) return null;
  return value;
}

export function doiToHttpsUrl(doi: string): string | null {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const path = normalized.split('/').map(encodeURIComponent).join('/');
  return `https://doi.org/${path}`;
}

/**
 * Hosts a proxied link must never resolve to. Blocks loopback, link-local, and
 * RFC1918 ranges so a hostile `citation_pdf_url` cannot turn the fetch into an
 * SSRF probe of the local network.
 */
export function isBlockedHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  ) {
    return true;
  }
  // IPv6 loopback, unspecified, link-local (fe80::/10), and unique-local
  // (fc00::/7) literals. IPv4-mapped forms (::ffff:127.0.0.1) are handled by the
  // IPv4 check below after the mapped suffix is isolated.
  if (normalized === '::1' || normalized === '0.0.0.0' || normalized === '::') return true;
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;
  // IPv6 multicast (ff00::/8).
  if (/^ff[0-9a-f]{2}:/i.test(normalized)) return true;

  // IPv4-mapped IPv6. The URL parser compresses ::ffff:127.0.0.1 to the hex form
  // ::ffff:7f00:1, so fold the trailing two 16-bit groups back to dotted-quad
  // and let the IPv4 rules decide (loopback/private mapped addresses are blocked).
  let ipv4Candidate = normalized;
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(normalized);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalized);
  if (mappedDotted) {
    ipv4Candidate = mappedDotted[1];
  } else if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    ipv4Candidate = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4Candidate);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  // Carrier-grade NAT (100.64.0.0/10), which VPN overlays such as Tailscale use.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Multicast and reserved (224.0.0.0 and above).
  if (a >= 224) return true;
  return false;
}

/** Turn a public or already-proxied URL into an https URL on NEU's EZproxy. */
export function toEzproxyFetchUrl(target: string): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (isBlockedHostname(url.hostname)) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  if (isEzproxyHostname(url.hostname)) {
    url.protocol = 'https:';
    return url.href;
  }

  // EZproxy reads `url=` raw and `qurl=` percent-encoded. An encoded `url=` is not
  // honored and lands on the /menu page, so encoded targets must use `qurl=`.
  return `${EZPROXY_LOGIN_ORIGIN}/login?qurl=${encodeURIComponent(url.href)}`;
}

const EZPROXY_HOST_SUFFIX = '.ezproxy.neu.edu';

/**
 * The publisher host behind an EZproxy-rewritten host, or null for EZproxy's own hosts
 * and anything off the proxy. EZproxy writes the publisher's dots as hyphens and its
 * hyphens as doubled hyphens: `link-springer-com.ezproxy.neu.edu` is `link.springer.com`.
 */
export function publisherHostFromEzproxy(host: string): string | null {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized.endsWith(EZPROXY_HOST_SUFFIX)) return null;
  const label = normalized.slice(0, -EZPROXY_HOST_SUFFIX.length);
  if (!label || label.includes('.') || label === 'link' || label === 'login') return null;
  const publisher = label.split('--').map((part) => part.replace(/-/g, '.')).join('-');
  return publisher.includes('.') ? publisher : null;
}

/** Route a DOI through NEU's EZproxy login prefix. */
export function buildEzproxyDoiUrl(doi: string): string | null {
  const doiUrl = doiToHttpsUrl(doi);
  if (!doiUrl) return null;
  return toEzproxyFetchUrl(doiUrl);
}

/**
 * True when EZproxy answered with its database menu instead of the target. That
 * happens with a valid session when the start URL was not accepted, so it is not
 * a sign-in problem.
 */
export function isEzproxyMenuPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'login.ezproxy.neu.edu' && host !== 'link.ezproxy.neu.edu') return false;
  return parsed.pathname.replace(/\/+$/, '') === '/menu';
}

/**
 * True when EZproxy answered with its "wait a moment or click here" hand-off page. It is a
 * bot-check style stop, never a sign-in problem, and its link must not be followed.
 */
export function isEzproxyInterstitial(url: string, html: string): boolean {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host !== 'link.ezproxy.neu.edu' && host !== 'login.ezproxy.neu.edu') return false;
  return /wait a moment or click\s+(?:<[^>]*>\s*)*here(?:\s*<[^>]*>)*\s+to continue/i.test(html);
}

/** True when a proxied response is EZproxy's own NU IT sign-in page. */
export function isEzproxyLoginPage(url: string, bodyText: string): boolean {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'login.ezproxy.neu.edu' && !isEzproxyMenuPage(url)) return true;
  return bodyText.includes('auth=shibbolethNU') || bodyText.includes('Authenticate with Northeastern credentials');
}

function domainAttributeAllowed(domain: string, requestHost: string): boolean {
  const normalized = domain.toLowerCase();
  const host = requestHost.toLowerCase();
  if (!isEzproxyHostname(normalized)) return false;
  return host === normalized || host.endsWith(`.${normalized}`);
}

function parseSetCookie(raw: string, requestHost: string): { cookie: StoredCookie; drop: boolean } | null {
  const parts = raw.split(';').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const nameValue = parts[0];
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const name = nameValue.slice(0, eq).trim();
  const value = nameValue.slice(eq + 1).trim();
  if (!name || /[;\r\n]/.test(name)) return null;

  let domain = requestHost;
  let domainCookie = false;
  let path = '/';
  let expires: number | undefined;
  let drop = false;

  for (const attr of parts.slice(1)) {
    const separator = attr.indexOf('=');
    const key = (separator === -1 ? attr : attr.slice(0, separator)).trim().toLowerCase();
    const attrValue = separator === -1 ? '' : attr.slice(separator + 1).trim();
    if (key === 'domain' && attrValue) {
      const requested = attrValue.replace(/^\./, '');
      if (!domainAttributeAllowed(requested, requestHost)) return null;
      domain = requested;
      domainCookie = true;
    } else if (key === 'path' && attrValue.startsWith('/')) {
      path = attrValue;
    } else if (key === 'max-age') {
      const maxAge = Number(attrValue);
      if (Number.isFinite(maxAge) && maxAge <= 0) drop = true;
      else if (Number.isFinite(maxAge)) expires = Math.floor(Date.now() / 1000) + maxAge;
    } else if (key === 'expires') {
      const parsed = Date.parse(attrValue);
      if (!Number.isNaN(parsed)) expires = Math.floor(parsed / 1000);
    }
  }

  if (!isEzproxyHostname(domain)) return null;

  return {
    drop,
    cookie: {
      name,
      value,
      domain: domainCookie ? `.${domain}` : domain,
      path,
      expires,
    },
  };
}

/**
 * Fold one `Set-Cookie` header from an EZproxy hop into the jar. Only cookies
 * scoped to `*.ezproxy.neu.edu` are kept, so a proxied publisher cannot plant a
 * cookie for a broader domain.
 */
export function absorbSetCookie(cookies: StoredCookie[], setCookie: string, requestHost: string): StoredCookie[] {
  const parsed = parseSetCookie(setCookie, requestHost);
  if (!parsed) return cookies;
  const domainKey = (parsed.cookie.domain ?? '').toLowerCase();
  const pathKey = parsed.cookie.path ?? '/';
  const next = cookies.filter(
    (cookie) =>
      !(
        cookie.name === parsed.cookie.name &&
        (cookie.domain ?? '').toLowerCase() === domainKey &&
        (cookie.path ?? '/') === pathKey
      )
  );
  if (!parsed.drop) next.push(parsed.cookie);
  return next;
}

function setCookieHeaders(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; tooLarge: boolean }> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return { bytes: new Uint8Array(), tooLarge: true };
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) return { bytes: new Uint8Array(), tooLarge: true };
    return { bytes, tooLarge: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      return { bytes: new Uint8Array(), tooLarge: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, tooLarge: false };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

type FetchError = Extract<ProxyFetchResult, { kind: 'error' }>;

/** One manual-redirect GET. `peer` names the far end in timeout messages. */
async function requestHop(
  fetchImpl: FetchLike,
  url: URL,
  cookie: string | null,
  remainingMs: number,
  timeoutMs: number,
  peer: string
): Promise<Response | FetchError> {
  try {
    return await fetchImpl(url.href, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
        'User-Agent': USER_AGENT,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(remainingMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { kind: 'error', finalUrl: url.href, message: `Timed out after ${timeoutMs}ms contacting ${peer}.` };
    }
    const message = err instanceof Error ? err.message : 'Request failed';
    return { kind: 'error', finalUrl: url.href, message };
  }
}

function redirectTarget(response: Response, url: URL): URL | FetchError {
  const location = response.headers.get('location');
  if (!location) {
    return { kind: 'error', finalUrl: url.href, message: 'The redirect was missing a Location header.' };
  }
  try {
    return new URL(location, url);
  } catch {
    return { kind: 'error', finalUrl: url.href, message: 'The redirect Location was not a valid URL.' };
  }
}

async function finalResponse(
  response: Response,
  url: URL,
  maxBytes: number,
  jar: StoredCookie[],
  redirects: number
): Promise<ProxyFetchResult> {
  const contentType = response.headers.get('content-type') ?? '';
  let body: { bytes: Uint8Array; tooLarge: boolean };
  try {
    body = await readLimitedBody(response, maxBytes);
  } catch (err) {
    // fetch() resolves once headers arrive; the timeout signal or a reset can still end the body.
    const name = err instanceof Error ? err.name : '';
    const message =
      name === 'AbortError' || name === 'TimeoutError'
        ? 'Timed out while downloading the response body.'
        : `The connection failed while downloading the response body (${err instanceof Error ? err.message : 'unknown error'}).`;
    return { kind: 'error', finalUrl: url.href, message };
  }
  if (body.tooLarge) {
    return {
      kind: 'too_large',
      finalUrl: url.href,
      message: `The response exceeded the ${maxBytes} byte download cap and was not parsed.`,
    };
  }
  return {
    kind: 'response',
    finalUrl: url.href,
    httpStatus: response.status,
    contentType,
    body: body.bytes,
    cookies: jar,
    redirects,
  };
}

/**
 * Fetch a proxied URL, following redirects only while they stay on `*.ezproxy.neu.edu`.
 * EZproxy hops between subdomains (`link` -> `login` -> a rewritten publisher host), and
 * Node's fetch drops a manually set Cookie header on cross-host redirects, so redirects
 * are followed here and the per-host cookie header is rebuilt by #5's `cookieHeaderForHost`.
 * No cookie is ever sent off the proxy. A redirect to an NEU sign-in host returns
 * `login_required`. A redirect to any other host returns `off_proxy`: EZproxy passes
 * through targets it does not proxy (often open-access publishers such as PLOS).
 */
export async function fetchEzproxyResource(
  startUrl: string,
  cookies: StoredCookie[],
  options: ProxyFetchOptions = {}
): Promise<ProxyFetchResult> {
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    return { kind: 'error', finalUrl: null, message: 'The full-text URL is not a valid URL.' };
  }
  if (url.protocol !== 'https:' || !isEzproxyHostname(url.hostname)) {
    return {
      kind: 'error',
      finalUrl: url.href,
      message: 'Refusing to fetch full text from a host outside NEU EZproxy.',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxDownloadBytes ?? FULL_TEXT_LIMITS.maxDownloadBytes;
  const maxRedirects = options.maxRedirects ?? FULL_TEXT_LIMITS.maxRedirects;
  const timeoutMs = options.timeoutMs ?? FULL_TEXT_LIMITS.timeoutMs;
  const nowMs = options.nowMs ?? Date.now();
  const deadline = Date.now() + timeoutMs;
  let jar = cookies.slice();
  const seen = new Set<string>();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (seen.has(url.href)) {
      return { kind: 'error', finalUrl: url.href, message: 'The proxy redirect chain looped.' };
    }
    seen.add(url.href);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        kind: 'error',
        finalUrl: url.href,
        message: `Timed out after ${timeoutMs}ms contacting the library proxy.`,
      };
    }

    const cookie = cookieHeaderForHost(jar, url.hostname, url.pathname, nowMs);
    const response = await requestHop(fetchImpl, url, cookie, remaining, timeoutMs, 'the library proxy');
    if (!(response instanceof Response)) return response;

    for (const setCookie of setCookieHeaders(response.headers)) {
      jar = absorbSetCookie(jar, setCookie, url.hostname);
    }

    if (isRedirect(response.status)) {
      const next = redirectTarget(response, url);
      if (!(next instanceof URL)) return next;
      if (isSignInHostname(next.hostname) && !isEzproxyHostname(next.hostname)) {
        return {
          kind: 'login_required',
          finalUrl: url.href,
          message:
            'EZproxy sent the request to NU IT sign-in. The saved session is missing or no longer accepted. Re-run `neu-onesearch-login` and finish the EZproxy step. Session cookies were not sent to that host.',
        };
      }
      if (!isEzproxyHostname(next.hostname)) {
        return {
          kind: 'off_proxy',
          finalUrl: url.href,
          offProxyUrl: next.href,
          message: `EZproxy accepted the session but passed the request through to ${next.hostname}, which is not on NEU's library proxy. The publisher is likely open access. Session cookies were not sent to that host.`,
        };
      }
      if (next.protocol !== 'https:') {
        return {
          kind: 'error',
          finalUrl: url.href,
          message: 'The proxy redirected to plain http. Refusing to send the session cookie without TLS.',
        };
      }
      url = next;
      continue;
    }

    return finalResponse(response, url, maxBytes, jar, hop);
  }

  return {
    kind: 'error',
    finalUrl: url.href,
    message: `Stopped after ${maxRedirects} proxy redirects.`,
  };
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

/** The eight 16-bit groups of an IPv6 literal, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let value = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIP(value) !== 6) return null;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    value = `${value.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = value.includes('::') ? value.split('::') : [value, null];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - headGroups.length - tailGroups.length).fill('0');
  const groups = [...headGroups, ...fill, ...tailGroups].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function isPublicIPv4(address: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match || isBlockedHostname(address)) return false;
  const [a, b, c] = match.slice(1).map(Number);
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/**
 * True only for a globally routable unicast address. IPv6 must be in 2000::/3, minus the
 * prefixes that tunnel or translate to IPv4 (6to4, Teredo) and documentation space, so an
 * address embedding a private IPv4 cannot slip through. NAT64 (64:ff9b::/96) and
 * IPv4-compatible (::/96) forms fall outside 2000::/3 and are refused with it.
 */
export function isPublicAddress(address: string): boolean {
  const value = address.trim().replace(/^\[|\]$/g, '');
  if (isIP(value) === 4) return isPublicIPv4(value);
  const groups = ipv6Groups(value);
  if (!groups) return false;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPublicIPv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
  }
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2002) return false; // 6to4
  if (groups[0] === 0x2001 && groups[1] === 0x0000) return false; // Teredo
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
export type ResolveAllLike = (hostname: string, options: LookupAllOptions, callback: LookupCallback) => void;

/**
 * A `net` lookup hook that resolves the host and refuses the connection unless every
 * address is public. The socket connects to the address this hook returns, so the check
 * and the connection use the same answer and a DNS rebind between them cannot reach a
 * private address.
 */
export function publicOnlyLookup(
  resolve: ResolveAllLike = dnsLookup as unknown as ResolveAllLike,
  isAllowed: (address: string) => boolean = isPublicAddress
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      if (addresses.length === 0 || addresses.some((entry) => !isAllowed(entry.address))) {
        const blocked: NodeJS.ErrnoException = new Error(`Refusing to connect: ${hostname} resolves to a non-public address.`);
        blocked.code = 'EADDRNOTPUBLIC';
        return callback(blocked, '', 0);
      }
      if (options.all) return (callback as unknown as LookupCallback)(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function toHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/**
 * A FetchLike over `node:http(s)` whose sockets connect only through `publicOnlyLookup`.
 * It never follows redirects and never decompresses (no Accept-Encoding is sent).
 */
export function createPinnedFetch(lookupHook: LookupFunction = publicOnlyLookup()): FetchLike {
  return (input, init = {}) =>
    new Promise<Response>((resolvePromise, reject) => {
      const url = new URL(input);
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = request(
        url,
        {
          method: init.method ?? 'GET',
          headers: init.headers as Record<string, string> | undefined,
          lookup: lookupHook,
          signal: init.signal ?? undefined,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 599) {
            res.destroy();
            reject(new Error(`Unexpected HTTP status ${status}.`));
            return;
          }
          const nullBody = status === 204 || status === 205 || status === 304;
          if (nullBody) res.resume();
          const body = nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
          resolvePromise(new Response(body, { status, statusText: res.statusMessage, headers: toHeaders(res) }));
        }
      );
      req.on('error', reject);
      req.end();
    });
}

/** Why a URL may not be fetched directly, or null when it is a public http(s) URL. */
async function publicUrlRefusal(url: URL, lookupImpl: LookupLike): Promise<string | null> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'only http and https URLs are fetched';
  if (url.username || url.password) return 'URLs with embedded credentials are not fetched';
  if (isBlockedHostname(url.hostname)) return 'the host is a local or private address';
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(url.hostname)) {
    return 'the host is not a public address';
  }
  let addresses: string[];
  try {
    addresses = await lookupImpl(url.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return `the host ${url.hostname} could not be resolved`;
  }
  if (addresses.length === 0) return `the host ${url.hostname} could not be resolved`;
  if (addresses.some((address) => !isPublicAddress(address))) return 'the host resolves to a local or private address';
  return null;
}

/**
 * Fetch a public URL directly, without any session cookie. Used for publishers that
 * EZproxy does not proxy (usually open access). Every hop must be http(s) and resolve
 * only to public addresses, so a hostile redirect cannot probe the local network. The
 * default transport re-checks the address at connect time (`createPinnedFetch`), so the
 * pre-check here is for clear messages, not the only guard.
 */
export async function fetchPublicResource(startUrl: string, options: ProxyFetchOptions = {}): Promise<ProxyFetchResult> {
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    return { kind: 'error', finalUrl: null, message: 'The publisher URL is not a valid URL.' };
  }

  const fetchImpl = options.fetchImpl ?? createPinnedFetch();
  const lookupImpl = options.lookupImpl ?? defaultLookup;
  const maxBytes = options.maxDownloadBytes ?? FULL_TEXT_LIMITS.maxDownloadBytes;
  const maxRedirects = options.maxRedirects ?? FULL_TEXT_LIMITS.maxRedirects;
  const timeoutMs = options.timeoutMs ?? FULL_TEXT_LIMITS.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (seen.has(url.href)) {
      return { kind: 'error', finalUrl: url.href, message: 'The publisher redirect chain looped.' };
    }
    seen.add(url.href);

    const refusal = await publicUrlRefusal(url, lookupImpl);
    if (refusal) {
      return { kind: 'error', finalUrl: url.href, message: `Refusing to fetch ${url.href}: ${refusal}.` };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { kind: 'error', finalUrl: url.href, message: `Timed out after ${timeoutMs}ms contacting the publisher.` };
    }

    const response = await requestHop(fetchImpl, url, null, remaining, timeoutMs, 'the publisher');
    if (!(response instanceof Response)) return response;

    if (isRedirect(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const next = redirectTarget(response, url);
      if (!(next instanceof URL)) return next;
      url = next;
      continue;
    }

    return finalResponse(response, url, maxBytes, [], hop);
  }

  return { kind: 'error', finalUrl: url.href, message: `Stopped after ${maxRedirects} publisher redirects.` };
}
