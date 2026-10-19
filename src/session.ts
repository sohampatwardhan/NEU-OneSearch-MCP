import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default on-disk location. Tool calls and login use `resolveSessionPath()` so the env override is honored. */
export const SESSION_PATH = join(homedir(), '.neu-onesearch-mcp', 'session.json');

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

interface StorageState {
  cookies?: StoredCookie[];
}

export function resolveSessionPath(): string {
  const override = process.env.NEU_ONESEARCH_SESSION_PATH?.trim();
  return override ? override : SESSION_PATH;
}

function belongsToOneSearch(cookie: StoredCookie): boolean {
  return (
    typeof cookie.domain === 'string' &&
    (cookie.domain === SESSION_DOMAIN || cookie.domain.endsWith(`.${SESSION_DOMAIN}`))
  );
}

export function isEzproxyHostname(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return normalized === EZPROXY_PARENT_DOMAIN || normalized.endsWith(`.${EZPROXY_PARENT_DOMAIN}`);
}

export function isCookieExpired(cookie: StoredCookie, nowMs: number = Date.now()): boolean {
  if (typeof cookie.expires !== 'number' || cookie.expires <= 0) return false;
  return cookie.expires * 1000 <= nowMs;
}

function cookieDomain(cookie: StoredCookie): string {
  return (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
}

/** A cookie EZproxy itself issued (parent domain or the login/entry hosts), ignoring expiry. */
function isEzproxyIssuedCookie(cookie: StoredCookie): boolean {
  if (!cookie.domain || !cookie.value) return false;
  if (/^ezproxy$/i.test(cookie.name) && isEzproxyHostname(cookieDomain(cookie))) return true;
  const domain = cookieDomain(cookie);
  return (
    domain === EZPROXY_PARENT_DOMAIN ||
    domain === 'link.ezproxy.neu.edu' ||
    domain === 'login.ezproxy.neu.edu'
  );
}

export function hasEzproxySession(cookies: StoredCookie[], nowMs: number = Date.now()): boolean {
  return cookies.some((cookie) => isEzproxyIssuedCookie(cookie) && !isCookieExpired(cookie, nowMs));
}

export type EzproxySessionState = 'ready' | 'absent' | 'expired' | 'onesearch_only' | 'unusable';

export function classifyEzproxySession(
  cookies: StoredCookie[] | null,
  nowMs: number = Date.now()
): EzproxySessionState {
  if (cookies === null) return 'absent';
  if (hasEzproxySession(cookies, nowMs)) return 'ready';
  const issued = cookies.filter(isEzproxyIssuedCookie);
  if (issued.length > 0 && issued.every((cookie) => isCookieExpired(cookie, nowMs))) return 'expired';
  if (cookies.some(belongsToOneSearch)) return 'onesearch_only';
  return 'unusable';
}

function domainMatchesHost(cookieDomainValue: string, host: string): boolean {
  const domain = cookieDomainValue.replace(/^\./, '').toLowerCase();
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  const hostOnly = !cookieDomainValue.startsWith('.');
  // Domain cookies are stored with a leading dot. The EZproxy parent is also
  // accepted without one, because a Domain=.ezproxy.neu.edu cookie has to be
  // sent to every proxied publisher host or the session never authenticates.
  if (!hostOnly || domain === 'ezproxy.neu.edu') {
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
 * Cookie header for one EZproxy host. Cookies scoped to a broader parent
 * (for example `.northeastern.edu`) are never included.
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

function readStorageState(path: string): StorageState | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as StorageState;
  } catch {
    return null;
  }
}

function normalizeCookies(state: StorageState | null): StoredCookie[] | null {
  if (!state || !Array.isArray(state.cookies)) return null;
  return state.cookies.filter(
    (cookie): cookie is StoredCookie =>
      Boolean(cookie) && typeof cookie.name === 'string' && typeof cookie.value === 'string'
  );
}

/** All cookies from the session file, or null when the file is missing or unreadable. */
export function loadStoredCookies(path: string = resolveSessionPath()): StoredCookie[] | null {
  const cookies = normalizeCookies(readStorageState(path));
  return cookies;
}

export function loadSession(path: string = resolveSessionPath()): string | null {
  const cookies = loadStoredCookies(path);
  if (!cookies) return null;

  const relevant = cookies.filter(belongsToOneSearch);
  if (relevant.length === 0) return null;

  return relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
