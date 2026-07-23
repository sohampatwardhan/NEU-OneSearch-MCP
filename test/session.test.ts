import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession } from '../src/session.js';

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
});
