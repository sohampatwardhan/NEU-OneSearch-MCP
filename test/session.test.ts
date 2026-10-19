import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyEzproxySession,
  cookieHeaderForHost,
  hasEzproxySession,
  loadSession,
  loadStoredCookies,
  resolveSessionPath,
} from '../src/session.js';

let tempDir: string | undefined;

function writeFixture(content: string): string {
  tempDir = mkdtempSync(join(tmpdir(), 'onesearch-session-test-'));
  const path = join(tempDir, 'session.json');
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('loadSession', () => {
  it('returns null when the file does not exist', () => {
    expect(loadSession('/nonexistent/path/session.json')).toBeNull();
  });

  it('returns null when the file contains invalid JSON', () => {
    const path = writeFixture('not valid json {{{');
    expect(loadSession(path)).toBeNull();
  });

  it('returns null when the file has no cookies array', () => {
    const path = writeFixture(JSON.stringify({ origins: [] }));
    expect(loadSession(path)).toBeNull();
  });

  it('returns null when the cookies array is empty', () => {
    const path = writeFixture(JSON.stringify({ cookies: [] }));
    expect(loadSession(path)).toBeNull();
  });

  it('formats a single cookie as a Cookie header value', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [{ name: 'JSESSIONID', value: 'abc123', domain: 'onesearch.library.northeastern.edu' }],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=abc123');
  });

  it('formats multiple cookies joined with "; "', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'abc123', domain: 'onesearch.library.northeastern.edu' },
          { name: 'urm_st', value: '456', domain: 'onesearch.library.northeastern.edu' },
        ],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=abc123; urm_st=456');
  });

  it('excludes cookies from unrelated domains (e.g. third-party analytics/SSO domains captured alongside the real session)', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'abc123', domain: 'onesearch.library.northeastern.edu' },
          { name: '_ga', value: 'GA1.2.xyz', domain: '.northeastern.edu' },
          { name: 'MUID', value: 'trackingvalue', domain: '.bing.com' },
        ],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=abc123');
  });

  it('resolves a duplicate cookie name across domains to only the onesearch-domain value (SSO/Duo login captures a second JSESSIONID for neuidmsso.neu.edu)', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'sso-session-value', domain: 'neuidmsso.neu.edu' },
          { name: 'JSESSIONID', value: 'onesearch-session-value', domain: 'onesearch.library.northeastern.edu' },
        ],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=onesearch-session-value');
  });

  it('rejects a suffix-superstring domain that is not actually a subdomain (e.g. an attacker-controlled "evilonesearch.library.northeastern.edu")', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'attacker-value', domain: 'evilonesearch.library.northeastern.edu' },
        ],
      })
    );
    expect(loadSession(path)).toBeNull();
  });

  it('returns null when the file has cookies but none match the onesearch domain', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [{ name: 'MUID', value: 'trackingvalue', domain: '.bing.com' }],
      })
    );
    expect(loadSession(path)).toBeNull();
  });

  it('does not put EZproxy cookies on the OneSearch Cookie header', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'onesearch', domain: 'onesearch.library.northeastern.edu' },
          { name: 'ezproxy', value: 'proxy-secret', domain: '.ezproxy.neu.edu' },
        ],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=onesearch');
  });
});

describe('EZproxy session cookies', () => {
  const now = Date.parse('2026-10-19T00:00:00Z');

  it('treats a parent-domain EZproxy cookie as a session', () => {
    const cookies = [{ name: 'ezproxy', value: 'abc', domain: '.ezproxy.neu.edu', path: '/' }];
    expect(hasEzproxySession(cookies, now)).toBe(true);
    expect(classifyEzproxySession(cookies, now)).toBe('ready');
  });

  it('does not treat a rewritten publisher host cookie as the library session', () => {
    const cookies = [{ name: 'JSESSIONID', value: 'pub', domain: 'www-nature-com.ezproxy.neu.edu' }];
    expect(hasEzproxySession(cookies, now)).toBe(false);
    expect(classifyEzproxySession(cookies, now)).toBe('unusable');
  });

  it('classifies an expired EZproxy cookie separately from a OneSearch-only file', () => {
    const expired = [{ name: 'ezproxy', value: 'old', domain: '.ezproxy.neu.edu', expires: 1 }];
    expect(classifyEzproxySession(expired, now)).toBe('expired');
    const onesearch = [{ name: 'JSESSIONID', value: 'abc', domain: 'onesearch.library.northeastern.edu' }];
    expect(classifyEzproxySession(onesearch, now)).toBe('onesearch_only');
    expect(classifyEzproxySession(null, now)).toBe('absent');
  });

  it('sends only cookies that match the EZproxy host, not broader NU cookies', () => {
    const cookies = [
      { name: 'ezproxy', value: 'proxy-secret', domain: '.ezproxy.neu.edu', path: '/' },
      { name: 'JSESSIONID', value: 'onesearch', domain: 'onesearch.library.northeastern.edu' },
      { name: 'sso', value: 'institution', domain: '.northeastern.edu' },
      { name: 'hostonly', value: 'link-only', domain: 'link.ezproxy.neu.edu', path: '/' },
    ];
    expect(cookieHeaderForHost(cookies, 'doi-org.ezproxy.neu.edu', '/10.1/abc', now)).toBe('ezproxy=proxy-secret');
    expect(
      cookieHeaderForHost(
        [{ name: 'ezproxy', value: 'no-dot', domain: 'ezproxy.neu.edu', path: '/' }],
        'doi-org.ezproxy.neu.edu',
        '/',
        now
      )
    ).toBe('ezproxy=no-dot');
    expect(cookieHeaderForHost(cookies, 'link.ezproxy.neu.edu', '/login', now)).toBe(
      'ezproxy=proxy-secret; hostonly=link-only'
    );
    expect(cookieHeaderForHost(cookies, 'publisher.example', '/', now)).toBeNull();
  });

  it('rejects a look-alike EZproxy domain and cookie values that could inject headers', () => {
    const cookies = [
      { name: 'ezproxy', value: 'nope', domain: '.ezproxy.neu.edu.evil.test' },
      { name: 'ezproxy', value: 'bad; injected=1', domain: '.ezproxy.neu.edu' },
    ];
    expect(cookieHeaderForHost(cookies, 'link.ezproxy.neu.edu', '/', now)).toBeNull();
  });

  it('reads stored cookies from a session file', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [{ name: 'ezproxy', value: 'abc', domain: '.ezproxy.neu.edu', path: '/', expires: -1 }],
      })
    );
    expect(loadStoredCookies(path)).toEqual([
      { name: 'ezproxy', value: 'abc', domain: '.ezproxy.neu.edu', path: '/', expires: -1 },
    ]);
  });

  it('uses NEU_ONESEARCH_SESSION_PATH when no explicit path is passed', () => {
    const path = writeFixture(JSON.stringify({ cookies: [] }));
    const previous = process.env.NEU_ONESEARCH_SESSION_PATH;
    process.env.NEU_ONESEARCH_SESSION_PATH = path;
    try {
      expect(resolveSessionPath()).toBe(path);
      expect(loadStoredCookies()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.NEU_ONESEARCH_SESSION_PATH;
      else process.env.NEU_ONESEARCH_SESSION_PATH = previous;
    }
  });
});
