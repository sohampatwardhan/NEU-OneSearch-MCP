import { describe, it, expect, vi } from 'vitest';
import {
  absorbSetCookie,
  buildEzproxyDoiUrl,
  fetchEzproxyResource,
  isBlockedHostname,
  normalizeDoi,
  toEzproxyFetchUrl,
} from '../src/ezproxy.js';
import type { StoredCookie } from '../src/session.js';

const SESSION: StoredCookie[] = [{ name: 'ezproxy', value: 'proxy-secret', domain: '.ezproxy.neu.edu', path: '/' }];

describe('normalizeDoi', () => {
  it('accepts a bare DOI, a doi.org URL, and a doi: prefix', () => {
    expect(normalizeDoi('10.1371/journal.pone.0212767')).toBe('10.1371/journal.pone.0212767');
    expect(normalizeDoi('https://doi.org/10.1371/journal.pone.0212767')).toBe('10.1371/journal.pone.0212767');
    expect(normalizeDoi('doi:10.1000/foo(bar)')).toBe('10.1000/foo(bar)');
  });

  it('rejects non-DOI URLs', () => {
    expect(normalizeDoi('https://evil.example/10.1000/abc')).toBeNull();
    expect(normalizeDoi('not-a-doi')).toBeNull();
  });
});

describe('EZproxy URL building', () => {
  it('wraps a DOI in the library login prefix', () => {
    expect(buildEzproxyDoiUrl('10.1371/journal.pone.0212767')).toBe(
      'https://link.ezproxy.neu.edu/login?url=' +
        encodeURIComponent('https://doi.org/10.1371/journal.pone.0212767')
    );
  });

  it('keeps an already-proxied URL on https and wraps a publisher PDF', () => {
    expect(toEzproxyFetchUrl('http://www-nature-com.ezproxy.neu.edu/articles/x.pdf')).toBe(
      'https://www-nature-com.ezproxy.neu.edu/articles/x.pdf'
    );
    expect(toEzproxyFetchUrl('https://publisher.example/article.pdf')).toBe(
      'https://link.ezproxy.neu.edu/login?url=' + encodeURIComponent('https://publisher.example/article.pdf')
    );
  });

  it('refuses private and non-http targets', () => {
    expect(isBlockedHostname('127.0.0.1')).toBe(true);
    expect(isBlockedHostname('169.254.169.254')).toBe(true);
    expect(toEzproxyFetchUrl('http://127.0.0.1/secret.pdf')).toBeNull();
    expect(toEzproxyFetchUrl('http://192.168.1.5/a.pdf')).toBeNull();
    expect(toEzproxyFetchUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('fetchEzproxyResource', () => {
  it('follows EZproxy redirects, keeps cookies on proxy hosts, and applies Set-Cookie', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://link.ezproxy.neu.edu/login')) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://doi-org.ezproxy.neu.edu/10.1/abc',
            'set-cookie': 'ezproxy=from-redirect; Domain=.ezproxy.neu.edu; Path=/',
          },
        });
      }
      return new Response('%PDF-1.4', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });

    const result = await fetchEzproxyResource('https://link.ezproxy.neu.edu/login?url=https%3A%2F%2Fdoi.org%2F10.1%2Fabc', [], {
      fetchImpl,
    });

    expect(result.kind).toBe('response');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondInit = fetchImpl.mock.calls[1][1] as RequestInit;
    expect((secondInit.headers as Record<string, string>).Cookie).toBe('ezproxy=from-redirect');
    expect(secondInit.redirect).toBe('manual');
    if (result.kind === 'response') {
      expect(result.finalUrl).toBe('https://doi-org.ezproxy.neu.edu/10.1/abc');
      expect(result.cookies.some((cookie) => cookie.name === 'ezproxy')).toBe(true);
    }
  });

  it('does not follow a redirect off EZproxy or send the session there', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://neuidmsso.neu.edu/idp/profile/SAML2/Redirect/SSO' },
      });
    });

    const result = await fetchEzproxyResource('https://login.ezproxy.neu.edu/login?auth=shibbolethNU', SESSION, {
      fetchImpl,
    });

    expect(result.kind).toBe('login_required');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requested = fetchImpl.mock.calls[0][0] as string;
    expect(requested).toContain('ezproxy.neu.edu');
    expect(requested).not.toContain('neuidmsso');
  });

  it('refuses a start URL that is not on EZproxy', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchEzproxyResource('https://doi.org/10.1/abc', SESSION, { fetchImpl });
    expect(result.kind).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops when the declared size exceeds the cap', async () => {
    const fetchImpl = vi.fn(async () => {
      const headers = new Headers({ 'content-type': 'application/pdf' });
      headers.set('content-length', '999999');
      return {
        status: 200,
        headers,
        body: {
          cancel: async () => undefined,
          getReader: () => {
            throw new Error('body should not be read');
          },
        },
      } as unknown as Response;
    });

    const result = await fetchEzproxyResource('https://link.ezproxy.neu.edu/login?url=x', SESSION, {
      fetchImpl,
      maxDownloadBytes: 100,
    });
    expect(result.kind).toBe('too_large');
  });
});

describe('absorbSetCookie', () => {
  it('ignores Set-Cookie for a non-EZproxy domain', () => {
    const next = absorbSetCookie(SESSION, 'sid=other; Domain=.northeastern.edu; Path=/', 'login.ezproxy.neu.edu');
    expect(next).toEqual(SESSION);
  });
});
