import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSession,
  loadStoredCookies,
  writeSessionCache,
  isCookieExpired,
  isEzproxyHostname,
  hasEzproxySession,
  hasOneSearchSession,
  classifySession,
  classifyEzproxySession,
  cookieHeaderForHost,
  type StoredCookie,
} from '../src/session.js';

let tempDir: string | undefined;

function newPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'onesearch-session-test-'));
  return join(tempDir, 'session.json');
}

function writeFixture(content: string): string {
  const path = newPath();
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

const ONESEARCH = 'onesearch.library.northeastern.edu';

describe('loadSession (OneSearch Cookie header)', () => {
  it('returns null when the file does not exist', () => {
    expect(loadSession('/nonexistent/path/session.json')).toBeNull();
  });

  it('returns null when the file contains invalid JSON', () => {
    expect(loadSession(writeFixture('not valid json {{{'))).toBeNull();
  });

  it('returns null when there is no cookies array', () => {
    expect(loadSession(writeFixture(JSON.stringify({ origins: [] })))).toBeNull();
  });

  it('returns null when the cookies array is empty', () => {
    expect(loadSession(writeFixture(JSON.stringify({ cookies: [] })))).toBeNull();
  });

  it('formats a single OneSearch cookie as a Cookie header value', () => {
    const path = writeFixture(
      JSON.stringify({ cookies: [{ name: 'JSESSIONID', value: 'abc123', domain: ONESEARCH }] })
    );
    expect(loadSession(path)).toBe('JSESSIONID=abc123');
  });

  it('formats multiple OneSearch cookies joined with "; "', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'abc123', domain: ONESEARCH },
          { name: 'urm_st', value: '456', domain: ONESEARCH },
        ],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=abc123; urm_st=456');
  });

  it('excludes cookies from unrelated domains', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'abc123', domain: ONESEARCH },
          { name: '_ga', value: 'GA1.2.xyz', domain: '.northeastern.edu' },
          { name: 'MUID', value: 'trackingvalue', domain: '.bing.com' },
        ],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=abc123');
  });

  it('resolves a duplicate cookie name to only the onesearch-domain value', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'sso-session-value', domain: 'neuidmsso.neu.edu' },
          { name: 'JSESSIONID', value: 'onesearch-session-value', domain: ONESEARCH },
        ],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=onesearch-session-value');
  });

  it('rejects a suffix-superstring domain that is not a real subdomain', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [{ name: 'JSESSIONID', value: 'attacker-value', domain: 'evilonesearch.library.northeastern.edu' }],
      })
    );
    expect(loadSession(path)).toBeNull();
  });

  it('reads the new { cookies, capturedAt } cache format', () => {
    const path = writeFixture(
      JSON.stringify({
        capturedAt: Date.now(),
        cookies: [{ name: 'JSESSIONID', value: 'new-fmt', domain: ONESEARCH }],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=new-fmt');
  });
});

describe('writeSessionCache / loadStoredCookies round-trip', () => {
  it('writes 0600 and reads back the cookies', () => {
    const path = newPath();
    const cookies: StoredCookie[] = [
      { name: 'ezproxy', value: 'E1', domain: '.ezproxy.neu.edu' },
      { name: 'JSESSIONID', value: 'O1', domain: ONESEARCH },
    ];
    writeSessionCache(cookies, 1_700_000_000_000, path);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const back = loadStoredCookies(path);
    expect(back).toHaveLength(2);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect(parsed.capturedAt).toBe(1_700_000_000_000);
  });

  it('loadStoredCookies returns null for missing/unreadable/malformed files', () => {
    expect(loadStoredCookies('/nonexistent/x.json')).toBeNull();
    expect(loadStoredCookies(writeFixture('garbage{'))).toBeNull();
    expect(loadStoredCookies(writeFixture(JSON.stringify({ nope: 1 })))).toBeNull();
  });
});

describe('isCookieExpired', () => {
  const now = 1_700_000_000_000; // ms
  it('treats a cookie with no expiry as a session cookie (not expired)', () => {
    expect(isCookieExpired({ name: 'a', value: 'b' }, now)).toBe(false);
    expect(isCookieExpired({ name: 'a', value: 'b', expires: -1 }, now)).toBe(false);
  });
  it('is expired when the expiry (unix seconds) is in the past', () => {
    expect(isCookieExpired({ name: 'a', value: 'b', expires: now / 1000 - 10 }, now)).toBe(true);
  });
  it('is not expired when the expiry is in the future', () => {
    expect(isCookieExpired({ name: 'a', value: 'b', expires: now / 1000 + 3600 }, now)).toBe(false);
  });
});

describe('isEzproxyHostname', () => {
  it('matches the parent and subdomains', () => {
    expect(isEzproxyHostname('ezproxy.neu.edu')).toBe(true);
    expect(isEzproxyHostname('link.ezproxy.neu.edu')).toBe(true);
    expect(isEzproxyHostname('doi-org.ezproxy.neu.edu')).toBe(true);
  });
  it('rejects unrelated and look-alike hosts', () => {
    expect(isEzproxyHostname('northeastern.edu')).toBe(false);
    expect(isEzproxyHostname('evilezproxy.neu.edu')).toBe(false);
  });
});

describe('session presence helpers', () => {
  const now = 1_700_000_000_000;
  const ezActive: StoredCookie = { name: 'ezproxy', value: 'x', domain: '.ezproxy.neu.edu' };
  const ezExpired: StoredCookie = { name: 'ezproxy', value: 'x', domain: '.ezproxy.neu.edu', expires: now / 1000 - 1 };
  const oneSearch: StoredCookie = { name: 'JSESSIONID', value: 'x', domain: ONESEARCH };

  it('hasEzproxySession true only with an unexpired EZproxy-issued cookie', () => {
    expect(hasEzproxySession([ezActive], now)).toBe(true);
    expect(hasEzproxySession([ezExpired], now)).toBe(false);
    expect(hasEzproxySession([oneSearch], now)).toBe(false);
  });

  it('hasOneSearchSession true only with an unexpired OneSearch cookie', () => {
    expect(hasOneSearchSession([oneSearch], now)).toBe(true);
    expect(hasOneSearchSession([ezActive], now)).toBe(false);
  });
});

describe('classifySession', () => {
  const now = 1_700_000_000_000;
  it('absent when cookies is null', () => {
    expect(classifySession(null, now)).toBe('absent');
  });
  it('ready when an EZproxy or OneSearch session cookie is live', () => {
    expect(classifySession([{ name: 'ezproxy', value: 'x', domain: '.ezproxy.neu.edu' }], now)).toBe('ready');
    expect(classifySession([{ name: 'JSESSIONID', value: 'x', domain: ONESEARCH }], now)).toBe('ready');
  });
  it('expired when known session cookies are all past expiry', () => {
    expect(
      classifySession(
        [{ name: 'ezproxy', value: 'x', domain: '.ezproxy.neu.edu', expires: now / 1000 - 1 }],
        now
      )
    ).toBe('expired');
  });
  it('unusable when only unrelated cookies are present', () => {
    expect(classifySession([{ name: '_ga', value: 'x', domain: '.bing.com' }], now)).toBe('unusable');
  });
});

describe('cookieHeaderForHost', () => {
  const now = 1_700_000_000_000;
  const jar: StoredCookie[] = [
    { name: 'ezproxy', value: 'E', domain: '.ezproxy.neu.edu' },
    { name: 'sid', value: 'S', domain: 'doi-org.ezproxy.neu.edu' },
    { name: 'leak', value: 'L', domain: '.northeastern.edu' },
    { name: 'dead', value: 'D', domain: '.ezproxy.neu.edu', expires: now / 1000 - 1 },
  ];

  it('returns only EZproxy-scoped, unexpired cookies for an EZproxy host', () => {
    const header = cookieHeaderForHost(jar, 'doi-org.ezproxy.neu.edu', '/', now);
    expect(header).toContain('ezproxy=E');
    expect(header).toContain('sid=S');
    expect(header).not.toContain('leak=L');
    expect(header).not.toContain('dead=D');
  });

  it('returns null for a non-EZproxy host (never leaks the jar)', () => {
    expect(cookieHeaderForHost(jar, 'publisher.com', '/', now)).toBeNull();
  });

  it('does not send a host-only cookie to a different host', () => {
    const header = cookieHeaderForHost(jar, 'link.ezproxy.neu.edu', '/', now);
    expect(header).not.toContain('sid=S'); // host-only for doi-org
  });
});

describe('classifyEzproxySession', () => {
  const now = 1_700_000_000_000;
  const ez: StoredCookie = { name: 'ezproxy', value: 'x', domain: '.ezproxy.neu.edu' };
  const ezExpired: StoredCookie = { name: 'ezproxy', value: 'x', domain: '.ezproxy.neu.edu', expires: now / 1000 - 1 };
  const oneSearch: StoredCookie = { name: 'JSESSIONID', value: 'x', domain: ONESEARCH };

  it('absent when cookies is null', () => {
    expect(classifyEzproxySession(null, now)).toBe('absent');
  });
  it('ready with a live EZproxy-issued cookie', () => {
    expect(classifyEzproxySession([ez], now)).toBe('ready');
    expect(classifyEzproxySession([ez, oneSearch], now)).toBe('ready');
  });
  it('expired when EZproxy cookies are all past expiry', () => {
    expect(classifyEzproxySession([ezExpired], now)).toBe('expired');
  });
  it('onesearch_only when only OneSearch cookies are present', () => {
    expect(classifyEzproxySession([oneSearch], now)).toBe('onesearch_only');
  });
  it('unusable when no recognized session cookie is present', () => {
    expect(classifyEzproxySession([{ name: '_ga', value: 'x', domain: '.bing.com' }], now)).toBe('unusable');
  });
});
