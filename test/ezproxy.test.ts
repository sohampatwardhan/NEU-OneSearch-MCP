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
  isEzproxyMenuPage,
  isEzproxyInterstitial,
  absorbSetCookie,
  fetchEzproxyResource,
  fetchPublicResource,
  isPublicAddress,
  publicOnlyLookup,
  createPinnedFetch,
  type ResolveAllLike,
} from '../src/ezproxy.js';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isSignInHostname } from '../src/auth.js';
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
    expect(url).toBe(`${EZPROXY_LOGIN_ORIGIN}/login?qurl=${encodeURIComponent('https://doi.org/10.1000/xyz')}`);
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
      `${EZPROXY_LOGIN_ORIGIN}/login?qurl=${encodeURIComponent('https://doi.org/10.1000/xyz')}`
    );
  });
  it('uses qurl= so the encoded target is honored, never an encoded url=', () => {
    const url = toEzproxyFetchUrl('https://www.nature.com/articles/nature14539');
    expect(url).toMatch(/\/login\?qurl=https%3A%2F%2F/);
    expect(url).not.toMatch(/[?&]url=/);
  });
  it("keeps the target's own query string intact", () => {
    const target = 'https://publisher.example/article?id=42&format=pdf';
    const url = new URL(toEzproxyFetchUrl(target)!);
    expect([...url.searchParams.keys()]).toEqual(['qurl']);
    expect(url.searchParams.get('qurl')).toBe(target);
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
  it('blocks IPv6 unspecified, link-local, unique-local, and IPv4-mapped loopback', () => {
    for (const h of ['::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '[fe80::1]', '[::1]']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
  });
  it('blocks carrier-grade NAT, multicast, and reserved ranges', () => {
    for (const h of ['100.64.0.1', '100.100.100.100', '100.127.255.254', '224.0.0.1', '255.255.255.255', 'ff02::1']) {
      expect(isBlockedHostname(h)).toBe(true);
    }
    expect(isBlockedHostname('100.63.0.1')).toBe(false);
    expect(isBlockedHostname('100.128.0.1')).toBe(false);
  });
  it('does not block public IPv6 or an IPv4-mapped public address', () => {
    expect(isBlockedHostname('2606:4700::1111')).toBe(false);
    expect(isBlockedHostname('::ffff:8.8.8.8')).toBe(false);
  });
  it('allows public hosts', () => {
    expect(isBlockedHostname('doi.org')).toBe(false);
    expect(isBlockedHostname('link.ezproxy.neu.edu')).toBe(false);
  });
});

describe('toEzproxyFetchUrl SSRF normalization', () => {
  // The WHATWG URL parser normalizes obfuscated IPv4 literals to dotted-quad,
  // which isBlockedHostname then rejects. Pin that so a future refactor cannot
  // regress the private-host guard silently.
  it('rejects decimal, hex, and short-form IPv4 loopback', () => {
    expect(toEzproxyFetchUrl('http://2130706433/secret')).toBeNull();
    expect(toEzproxyFetchUrl('http://0x7f000001/secret')).toBeNull();
    expect(toEzproxyFetchUrl('http://127.1/secret')).toBeNull();
  });
  it('rejects IPv6 loopback and private literals', () => {
    expect(toEzproxyFetchUrl('http://[::1]/secret')).toBeNull();
    expect(toEzproxyFetchUrl('http://[fe80::1]/secret')).toBeNull();
    expect(toEzproxyFetchUrl('http://[fc00::1]/secret')).toBeNull();
    expect(toEzproxyFetchUrl('http://[::ffff:127.0.0.1]/secret')).toBeNull();
  });
});

describe('isEzproxyLoginPage', () => {
  it('detects the login host and sign-in markers', () => {
    expect(isEzproxyLoginPage('https://login.ezproxy.neu.edu/login?url=x', '')).toBe(true);
    expect(isEzproxyLoginPage('https://doi-org.ezproxy.neu.edu/x', 'auth=shibbolethNU')).toBe(true);
    expect(isEzproxyLoginPage('https://doi-org.ezproxy.neu.edu/x', 'the article body')).toBe(false);
  });
  it('does not treat the database menu as the sign-in page', () => {
    expect(isEzproxyLoginPage('https://login.ezproxy.neu.edu/menu', '<title>Database Menu</title>')).toBe(false);
  });
});

describe('isEzproxyMenuPage', () => {
  it('detects the menu on the login and link hosts only', () => {
    expect(isEzproxyMenuPage('https://login.ezproxy.neu.edu/menu')).toBe(true);
    expect(isEzproxyMenuPage('https://link.ezproxy.neu.edu/menu/')).toBe(true);
    expect(isEzproxyMenuPage('https://www-nature-com.ezproxy.neu.edu/menu')).toBe(false);
    expect(isEzproxyMenuPage('https://login.ezproxy.neu.edu/login?qurl=x')).toBe(false);
    expect(isEzproxyMenuPage('not a url')).toBe(false);
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

  it('returns login_required on a redirect to the NEU IdP, without sending the cookie there', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('neuidmsso.neu.edu')) throw new Error('cookie reached off-proxy host');
      return new Response(null, { status: 302, headers: { location: 'https://neuidmsso.neu.edu/idp/profile/SAML2/Redirect/SSO' } });
    });
    const result = await fetchEzproxyResource('https://link.ezproxy.neu.edu/login?qurl=x', ezJar, { fetchImpl });
    expect(result.kind).toBe('login_required');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns off_proxy when EZproxy passes an unproxied publisher through, without contacting it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('plos.org')) throw new Error('cookie reached off-proxy host');
      if (url.startsWith('https://link.ezproxy.neu.edu/')) {
        return new Response(null, { status: 302, headers: { location: 'https://doi-org.ezproxy.neu.edu/10.1371/journal.pone.0212767' } });
      }
      return new Response(null, { status: 302, headers: { location: 'https://dx.plos.org/10.1371/journal.pone.0212767' } });
    });
    const result = await fetchEzproxyResource('https://link.ezproxy.neu.edu/login?qurl=x', ezJar, { fetchImpl });
    expect(result.kind).toBe('off_proxy');
    if (result.kind !== 'off_proxy') return;
    expect(result.offProxyUrl).toBe('https://dx.plos.org/10.1371/journal.pone.0212767');
    expect(result.finalUrl).toBe('https://doi-org.ezproxy.neu.edu/10.1371/journal.pone.0212767');
    expect(result.message).toMatch(/not on NEU's library proxy/);
    expect(result.message).not.toContain('SECRET');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses a plain-http redirect on the proxy instead of sending the cookie without TLS', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('http:')) throw new Error('cookie sent over http');
      return new Response(null, { status: 302, headers: { location: 'http://doi-org.ezproxy.neu.edu/10.1/x' } });
    });
    const result = await fetchEzproxyResource('https://link.ezproxy.neu.edu/login?qurl=x', ezJar, { fetchImpl });
    expect(result.kind).toBe('error');
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

describe('isSignInHostname', () => {
  it('matches Microsoft Entra sign-in hosts used after the 1Login move', () => {
    for (const h of ['login.microsoftonline.com', 'LOGIN.MICROSOFTONLINE.COM', 'login.microsoft.com', 'login.windows.net']) {
      expect(isSignInHostname(h)).toBe(true);
    }
  });
  it('rejects look-alikes of the Microsoft sign-in hosts', () => {
    for (const h of [
      'login.microsoftonline.com.evil.example',
      'evil-login.microsoftonline.com.example',
      'evil-login.microsoftonline.com',
      'login.microsoftonline.co',
      'xlogin.microsoft.com',
    ]) {
      expect(isSignInHostname(h)).toBe(false);
    }
  });
  it('matches NEU IdP and Duo hosts but not publishers', () => {
    expect(isSignInHostname('neuidmsso.neu.edu')).toBe(true);
    expect(isSignInHostname('api-123.duosecurity.com')).toBe(true);
    expect(isSignInHostname('dx.plos.org')).toBe(false);
    expect(isSignInHostname('journals.plos.org')).toBe(false);
  });
});

describe('fetchPublicResource', () => {
  const publicLookup = async () => ['151.101.1.1'];

  it('follows redirects and never sends a Cookie header', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://dx.plos.org/')) {
        return new Response(null, { status: 302, headers: { location: 'https://journals.plos.org/plosone/article?id=x' } });
      }
      return new Response('<html>article</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const result = await fetchPublicResource('https://dx.plos.org/10.1371/x', { fetchImpl, lookupImpl: publicLookup });
    expect(result.kind).toBe('response');
    if (result.kind !== 'response') return;
    expect(result.finalUrl).toBe('https://journals.plos.org/plosone/article?id=x');
    expect(result.cookies).toEqual([]);
    for (const [, init] of fetchImpl.mock.calls as [string, RequestInit][]) {
      expect(init.headers as Record<string, string>).not.toHaveProperty('Cookie');
    }
  });

  it('refuses a private literal host without fetching', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPublicResource('http://127.0.0.1/secret', { fetchImpl, lookupImpl: publicLookup });
    expect(result.kind).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPublicResource('https://rebind.example/x', {
      fetchImpl,
      lookupImpl: async () => ['93.184.216.34', '10.0.0.7'],
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toMatch(/private address/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a private host', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
    );
    const result = await fetchPublicResource('https://publisher.example/x', { fetchImpl, lookupImpl: publicLookup });
    expect(result.kind).toBe('error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a host whose IPv6 address embeds a private IPv4 (6to4)', async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPublicResource('https://tunnel.example/x', {
      fetchImpl,
      lookupImpl: async () => ['2002:a00:1::1'],
    });
    expect(result.kind).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses non-http schemes', async () => {
    const result = await fetchPublicResource('file:///etc/passwd', { fetchImpl: vi.fn(), lookupImpl: publicLookup });
    expect(result.kind).toBe('error');
  });
});

describe('isPublicAddress', () => {
  it('allows global unicast IPv4 and IPv6', () => {
    for (const a of ['8.8.8.8', '151.101.1.1', '2606:4700::1111', '[2a00:1450:4001::200e]', '::ffff:8.8.8.8']) {
      expect(isPublicAddress(a)).toBe(true);
    }
  });
  it('refuses private, reserved, and documentation IPv4', () => {
    for (const a of ['10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.169.254', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '0.0.0.0', '240.0.0.1']) {
      expect(isPublicAddress(a)).toBe(false);
    }
  });
  it('refuses IPv6 forms that embed or translate to IPv4', () => {
    for (const a of [
      '2002:7f00:1::1', // 6to4 of 127.0.0.1
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
      '64:ff9b::10.0.0.1',
      '::7f00:1', // IPv4-compatible
      '::127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isPublicAddress(a)).toBe(false);
    }
  });
  it('refuses non-global IPv6 and non-addresses', () => {
    for (const a of ['::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '2001:db8::1', 'example.com', '']) {
      expect(isPublicAddress(a)).toBe(false);
    }
  });
});

describe('publicOnlyLookup', () => {
  const stub =
    (addresses: string[]): ResolveAllLike =>
    (_host, _opts, cb) =>
      cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('returns the first address, or all of them when asked', async () => {
    const hook = publicOnlyLookup(stub(['151.101.1.1', '2606:4700::1111']));
    const one = await new Promise<unknown[]>((resolve) => hook('pub.test', {}, (...args) => resolve(args)));
    expect(one).toEqual([null, '151.101.1.1', 4]);
    const all = await new Promise<unknown[]>((resolve) => hook('pub.test', { all: true }, (...args) => resolve(args)));
    expect(all[1]).toHaveLength(2);
  });

  it('fails the connection when any resolved address is not public', async () => {
    const hook = publicOnlyLookup(stub(['151.101.1.1', '10.0.0.7']));
    const [err] = await new Promise<unknown[]>((resolve) => hook('rebind.test', {}, (...args) => resolve(args)));
    expect((err as NodeJS.ErrnoException).code).toBe('EADDRNOTPUBLIC');
  });
});

describe('createPinnedFetch', () => {
  async function withServer(run: (port: number, hits: IncomingHttpHeaders[]) => Promise<void>) {
    const hits: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      hits.push(req.headers);
      if (req.url === '/start') {
        res.writeHead(302, { location: '/article' }).end('moved');
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>open article</html>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run((server.address() as AddressInfo).port, hits);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  const toLoopback: ResolveAllLike = (_host, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]);

  it('refuses at connect time when DNS rebinds to a private address after the pre-check', async () => {
    await withServer(async (port, hits) => {
      const result = await fetchPublicResource(`http://rebind.test:${port}/start`, {
        // The pre-check sees a public address; the connection-time lookup sees loopback.
        lookupImpl: async () => ['151.101.1.1'],
        fetchImpl: createPinnedFetch(publicOnlyLookup(toLoopback)),
      });
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.message).toMatch(/non-public address/);
      expect(hits).toHaveLength(0);
    });
  });

  it('follows redirects over node:http without sending cookies', async () => {
    await withServer(async (port, hits) => {
      const result = await fetchPublicResource(`http://pub.test:${port}/start`, {
        lookupImpl: async () => ['151.101.1.1'],
        fetchImpl: createPinnedFetch(publicOnlyLookup(toLoopback, () => true)),
      });
      expect(result.kind).toBe('response');
      if (result.kind !== 'response') return;
      expect(result.finalUrl).toBe(`http://pub.test:${port}/article`);
      expect(new TextDecoder().decode(result.body)).toContain('open article');
      expect(hits).toHaveLength(2);
      for (const headers of hits) expect(headers.cookie).toBeUndefined();
    });
  });
});

describe('isEzproxyInterstitial', () => {
  const html = readFileSync(new URL('./fixtures/ezproxy-interstitial.html', import.meta.url), 'utf-8');
  it('is true for the wait-a-moment page on an EZproxy login host', () => {
    expect(isEzproxyInterstitial('https://link.ezproxy.neu.edu/login?qurl=https%3A%2F%2Fdoi.org%2Fx', html)).toBe(true);
    expect(isEzproxyInterstitial('https://login.ezproxy.neu.edu/login', html.toUpperCase())).toBe(true);
  });
  it('is false for the same text on a publisher host or without the text', () => {
    expect(isEzproxyInterstitial('https://www.example-publisher.com/article', html)).toBe(false);
    expect(isEzproxyInterstitial('https://link.ezproxy.neu.edu/login', '<html>hello</html>')).toBe(false);
    expect(isEzproxyInterstitial('not a url', html)).toBe(false);
  });
});
