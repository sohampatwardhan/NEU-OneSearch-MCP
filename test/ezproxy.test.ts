import { describe, it, expect } from 'vitest';
import {
  EZPROXY_LOGIN_ORIGIN,
  EZPROXY_PROBE_DOI,
  normalizeDoi,
  doiToHttpsUrl,
  buildEzproxyDoiUrl,
  toEzproxyFetchUrl,
  isBlockedHostname,
  isEzproxyLoginPage,
  absorbSetCookie,
  fetchEzproxyResource,
} from '../src/ezproxy.js';
import { vi } from 'vitest';
import type { StoredCookie } from '../src/session.js';

describe('normalizeDoi', () => {
  it('accepts a bare DOI', () => {
    expect(normalizeDoi('10.1038/s41586-020-2649-2')).toBe('10.1038/s41586-020-2649-2');
  });
  it('strips a doi: prefix and a doi.org URL', () => {
    expect(normalizeDoi('doi:10.1000/xyz')).toBe('10.1000/xyz');
    expect(normalizeDoi('https://doi.org/10.1000/xyz')).toBe('10.1000/xyz');
    expect(normalizeDoi('https://dx.doi.org/10.1000/xyz')).toBe('10.1000/xyz');
  });
  it('rejects empty, non-DOI, or non-doi.org URLs', () => {
    expect(normalizeDoi('')).toBeNull();
    expect(normalizeDoi('not a doi')).toBeNull();
    expect(normalizeDoi('https://evil.example/10.1/x')).toBeNull();
  });
});

describe('doiToHttpsUrl', () => {
  it('builds a doi.org URL with each path segment encoded', () => {
    expect(doiToHttpsUrl('10.1000/xyz')).toBe('https://doi.org/10.1000/xyz');
  });
  it('returns null for an invalid DOI', () => {
    expect(doiToHttpsUrl('nope')).toBeNull();
  });
});

describe('buildEzproxyDoiUrl', () => {
  it('routes a valid DOI through the library login prefix', () => {
    const url = buildEzproxyDoiUrl('10.1000/xyz');
    expect(url).toBe(`${EZPROXY_LOGIN_ORIGIN}/login?url=${encodeURIComponent('https://doi.org/10.1000/xyz')}`);
  });
  it('returns null for an invalid DOI', () => {
    expect(buildEzproxyDoiUrl('nope')).toBeNull();
  });
  it('has a valid probe DOI', () => {
    expect(buildEzproxyDoiUrl(EZPROXY_PROBE_DOI)).not.toBeNull();
  });
});

describe('toEzproxyFetchUrl', () => {
  it('wraps a public URL in the login prefix', () => {
    expect(toEzproxyFetchUrl('https://doi.org/10.1000/xyz')).toBe(
      `${EZPROXY_LOGIN_ORIGIN}/login?url=${encodeURIComponent('https://doi.org/10.1000/xyz')}`
    );
  });
  it('keeps an already-proxied host and forces https', () => {
    expect(toEzproxyFetchUrl('http://doi-org.ezproxy.neu.edu/10.1/x')).toBe('https://doi-org.ezproxy.neu.edu/10.1/x');
  });
  it('rejects private hosts, credentials, and non-http protocols', () => {
    expect(toEzproxyFetchUrl('http://127.0.0.1/secret.pdf')).toBeNull();
    expect(toEzproxyFetchUrl('http://localhost/x')).toBeNull();
    expect(toEzproxyFetchUrl('https://user:pass@doi.org/10.1/x')).toBeNull();
    expect(toEzproxyFetchUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('isBlockedHostname', () => {
  it('blocks loopback, link-local, and RFC1918', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '::1']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
  });
  it('allows public hosts', () => {
    expect(isBlockedHostname('doi.org')).toBe(false);
    expect(isBlockedHostname('link.ezproxy.neu.edu')).toBe(false);
  });
});

describe('isEzproxyLoginPage', () => {
  it('detects the login host and sign-in markers', () => {
    expect(isEzproxyLoginPage('https://login.ezproxy.neu.edu/login?url=x', '')).toBe(true);
    expect(isEzproxyLoginPage('https://doi-org.ezproxy.neu.edu/x', 'auth=shibbolethNU')).toBe(true);
    expect(isEzproxyLoginPage('https://doi-org.ezproxy.neu.edu/x', 'the article body')).toBe(false);
  });
});

describe('absorbSetCookie', () => {
  it('keeps an EZproxy-scoped cookie and ignores a broader-domain one', () => {
    let jar: StoredCookie[] = [];
    jar = absorbSetCookie(jar, 'ezproxy=abc; Domain=.ezproxy.neu.edu; Path=/', 'link.ezproxy.neu.edu');
    jar = absorbSetCookie(jar, 'evil=1; Domain=.northeastern.edu', 'link.ezproxy.neu.edu');
    expect(jar).toHaveLength(1);
    expect(jar[0].name).toBe('ezproxy');
  });
});

describe('fetchEzproxyResource', () => {
  const ezJar: StoredCookie[] = [{ name: 'ezproxy', value: 'SECRET', domain: '.ezproxy.neu.edu', path: '/' }];

  it('refuses a start URL outside EZproxy', async () => {
    const result = await fetchEzproxyResource('https://doi.org/10.1/x', ezJar, { fetchImpl: vi.fn() });
    expect(result.kind).toBe('error');
  });

  it('sends only the EZproxy-scoped cookie and returns the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const result = await fetchEzproxyResource('https://link.ezproxy.neu.edu/login?url=x', ezJar, { fetchImpl });
    expect(result.kind).toBe('response');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Cookie).toBe('ezproxy=SECRET');
  });

  it('returns login_required on a redirect off the proxy, without sending the cookie there', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('login.northeastern.edu')) throw new Error('cookie reached off-proxy host');
      return new Response(null, { status: 302, headers: { location: 'https://login.northeastern.edu/idp' } });
    });
    const result = await fetchEzproxyResource('https://link.ezproxy.neu.edu/login?url=x', ezJar, { fetchImpl });
    expect(result.kind).toBe('login_required');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns too_large when content-length exceeds the cap', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('x', { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '999999' } })
    );
    const result = await fetchEzproxyResource('https://link.ezproxy.neu.edu/x', ezJar, { fetchImpl, maxDownloadBytes: 10 });
    expect(result.kind).toBe('too_large');
  });
});
