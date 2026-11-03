import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { sessionCachePath } from './cache.js';

const SESSION_DOMAIN = 'onesearch.library.northeastern.edu';
const EZPROXY_PARENT_DOMAIN = 'ezproxy.neu.edu';

export interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Unix seconds. `<= 0` or omitted means a session cookie with no recorded expiry. */
  expires?: number;
}

/** Our own small on-disk shape: just the cookies we need plus a capture time. */
export interface SessionCache {
  cookies: StoredCookie[];
  capturedAt: number;
}

/** Shape of a Playwright storageState file, accepted on read for back-compat. */
interface StorageState {
  cookies?: StoredCookie[];
}

function belongsToOneSearch(cookie: StoredCookie): boolean {
  return (
    typeof cookie.domain === 'string' &&
    (cookie.domain === SESSION_DOMAIN || cookie.domain.endsWith(`.${SESSION_DOMAIN}`))
  );
}

function cookieDomain(cookie: StoredCookie): string {
  return (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
}

export function isEzproxyHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return normalized === EZPROXY_PARENT_DOMAIN || normalized.endsWith(`.${EZPROXY_PARENT_DOMAIN}`);
}

export function isCookieExpired(cookie: StoredCookie, nowMs: number = Date.now()): boolean {
  if (typeof cookie.expires !== 'number' || cookie.expires <= 0) return false;
  return cookie.expires * 1000 <= nowMs;
}

/** A cookie EZproxy itself issued (parent domain or the login/entry hosts), ignoring expiry. */
function isEzproxyIssuedCookie(cookie: StoredCookie): boolean {
  if (!cookie.domain || !cookie.value) return false;
  const domain = cookieDomain(cookie);
  if (/^ezproxy$/i.test(cookie.name) && isEzproxyHostname(domain)) return true;
  return (
    domain === EZPROXY_PARENT_DOMAIN ||
    domain === 'link.ezproxy.neu.edu' ||
    domain === 'login.ezproxy.neu.edu'
  );
}

export function hasEzproxySession(cookies: StoredCookie[], nowMs: number = Date.now()): boolean {
  return cookies.some((cookie) => isEzproxyIssuedCookie(cookie) && !isCookieExpired(cookie, nowMs));
}

export function hasOneSearchSession(cookies: StoredCookie[], nowMs: number = Date.now()): boolean {
  return cookies.some((cookie) => belongsToOneSearch(cookie) && Boolean(cookie.value) && !isCookieExpired(cookie, nowMs));
}

export type SessionState = 'ready' | 'absent' | 'expired' | 'unusable';

/**
 * Classify the cached session for a tool. `ready` means at least one live
 * OneSearch or EZproxy session cookie. `expired` means we hold such cookies but
 * all are past their recorded expiry. `unusable` means the cache has cookies but
 * none we recognize as a session. `absent` means no cache at all.
 *
 * Groundwork: `classifySession`, `cookieHeaderForHost`, and the `has*Session`
 * helpers are the host-scoped reuse path for a future EZproxy full-text tool
 * (out of scope here, tracked in issue #2). The two shipping tools
 * (`search_onesearch`, `get_record`) are anonymous in content, so they must not
 * pre-flight the cache and refuse a search that works fine anonymously; they
 * surface session loss only via the live redirect/401 path (see auth.ts). The
 * stored `capturedAt` is advisory for the same reason — expiry rides on cookie
 * `expires` and the live signal, not a fixed timer.
 */
export function classifySession(cookies: StoredCookie[] | null, nowMs: number = Date.now()): SessionState {
  if (cookies === null) return 'absent';
  if (hasEzproxySession(cookies, nowMs) || hasOneSearchSession(cookies, nowMs)) return 'ready';

  const known = cookies.filter((c) => isEzproxyIssuedCookie(c) || belongsToOneSearch(c));
  if (known.length > 0 && known.every((c) => isCookieExpired(c, nowMs))) return 'expired';
  return 'unusable';
}

export type EzproxySessionState = 'ready' | 'absent' | 'expired' | 'onesearch_only' | 'unusable';

/**
 * EZproxy-specific classification for the full-text tool. Unlike
 * `classifySession` (which the anonymous tools use and which treats a
 * OneSearch-only session as `ready`), full text needs a live EZproxy cookie: a
 * OneSearch login alone does not unlock proxied article downloads. Built on the
 * same `hasEzproxySession`/`belongsToOneSearch`/`isCookieExpired` helpers so the
 * two classifiers stay in sync; it does not change `classifySession`.
 */
export function classifyEzproxySession(
  cookies: StoredCookie[] | null,
  nowMs: number = Date.now()
): EzproxySessionState {
  if (cookies === null) return 'absent';
  if (hasEzproxySession(cookies, nowMs)) return 'ready';
  const issued = cookies.filter(isEzproxyIssuedCookie);
  if (issued.length > 0 && issued.every((c) => isCookieExpired(c, nowMs))) return 'expired';
  if (cookies.some(belongsToOneSearch)) return 'onesearch_only';
  return 'unusable';
}

function domainMatchesHost(cookieDomainValue: string, host: string): boolean {
  const domain = cookieDomainValue.replace(/^\./, '').toLowerCase();
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  const hostOnly = !cookieDomainValue.startsWith('.');
  // Domain cookies carry a leading dot. The EZproxy parent is also accepted
  // without one, because a Domain=.ezproxy.neu.edu cookie must be sent to every
  // proxied publisher host or the session never authenticates.
  if (!hostOnly || domain === EZPROXY_PARENT_DOMAIN) {
    return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
  }
  return normalizedHost === domain;
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  const path = cookiePath.length > 0 ? cookiePath : '/';
  const request = requestPath.length > 0 ? requestPath : '/';
  if (path === '/') return true;
  if (request === path) return true;
  const prefix = path.endsWith('/') ? path : `${path}/`;
  return request.startsWith(prefix);
}

/**
 * Cookie header for one EZproxy host. Cookies scoped to a broader parent (for
 * example `.northeastern.edu`) or to the IdP are never included, so the IdP
 * session is not leaked across hosts. Returns null for a non-EZproxy host.
 */
export function cookieHeaderForHost(
  cookies: StoredCookie[],
  host: string,
  requestPath: string = '/',
  nowMs: number = Date.now()
): string | null {
  if (!isEzproxyHostname(host)) return null;
  const pairs: string[] = [];
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value) continue;
    if (/[;\r\n]/.test(cookie.name) || /[;\r\n]/.test(cookie.value)) continue;
    if (!cookie.domain || !isEzproxyHostname(cookieDomain(cookie))) continue;
    if (!domainMatchesHost(cookie.domain, host)) continue;
    if (!pathMatches(cookie.path ?? '/', requestPath)) continue;
    if (isCookieExpired(cookie, nowMs)) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : null;
}

function readJson(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function normalizeCookies(value: unknown): StoredCookie[] | null {
  if (!value || typeof value !== 'object') return null;
  const cookies = (value as StorageState | SessionCache).cookies;
  if (!Array.isArray(cookies)) return null;
  return cookies.filter(
    (cookie): cookie is StoredCookie =>
      Boolean(cookie) && typeof cookie.name === 'string' && typeof cookie.value === 'string'
  );
}

/**
 * All cookies from the session cache, or null when the file is missing,
 * unreadable, or malformed. Accepts both our `{ cookies, capturedAt }` shape and
 * a Playwright `storageState` file (cookies array). Never throws.
 */
export function loadStoredCookies(path: string = sessionCachePath()): StoredCookie[] | null {
  return normalizeCookies(readJson(path));
}

/** Write the cookie cache with owner-only (0600) permissions. */
export function writeSessionCache(
  cookies: StoredCookie[],
  capturedAt: number = Date.now(),
  path: string = sessionCachePath()
): void {
  const payload: SessionCache = { cookies, capturedAt };
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
  // `mode` on write only applies when the file is created, and umask can weaken
  // it; the explicit chmod also tightens an existing file on re-login (Req 3.3).
  chmodSync(path, 0o600);
}

/**
 * OneSearch `Cookie` header for the Primo API, or null when there is no usable
 * OneSearch cookie. Kept for `primoClient`, which attaches it to catalog
 * requests. Unchanged anonymous behavior when the cache is absent.
 */
export function loadSession(path: string = sessionCachePath()): string | null {
  const cookies = loadStoredCookies(path);
  if (!cookies) return null;

  const relevant = cookies.filter(belongsToOneSearch);
  if (relevant.length === 0) return null;

  return relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
