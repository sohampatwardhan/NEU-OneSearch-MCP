import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFullText } from '../src/fullText.js';

const fixturePdf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tiny.pdf'));
const COOKIE = 'proxy-secret-value';

let tempDir: string | undefined;

function sessionFile(cookies: unknown[]): string {
  tempDir = mkdtempSync(join(tmpdir(), 'onesearch-fulltext-'));
  const path = join(tempDir, 'session.json');
  writeFileSync(path, JSON.stringify({ cookies }), 'utf-8');
  return path;
}

function ezproxySession(): string {
  return sessionFile([{ name: 'ezproxy', value: COOKIE, domain: '.ezproxy.neu.edu', path: '/', expires: -1 }]);
}

function pdfResponse(): Response {
  return new Response(fixturePdf, {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  vi.unstubAllGlobals();
});

describe('getFullText', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('does not fetch when no session file exists', async () => {
    const fetchImpl = vi.fn();
    const result = await getFullText(
      { doi: '10.1371/journal.pone.0212767' },
      { fetchImpl, sessionPath: '/nonexistent/neu-session.json' }
    );
    expect(result.status).toBe('login_required');
    expect(result.text).toBeNull();
    expect(result.sourceUrl).toContain('https://link.ezproxy.neu.edu/login?qurl=');
    expect(result.doi).toBe('10.1371/journal.pone.0212767');
    expect(JSON.stringify(result)).not.toContain(COOKIE);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tells the caller to redo login when the file only has OneSearch cookies', async () => {
    const path = sessionFile([
      { name: 'JSESSIONID', value: 'onesearch-secret', domain: 'onesearch.library.northeastern.edu' },
    ]);
    const fetchImpl = vi.fn();
    const result = await getFullText({ doi: '10.1000/xyz' }, { fetchImpl, sessionPath: path });
    expect(result.status).toBe('login_required');
    expect(result.message).toMatch(/OneSearch cookies but no EZproxy/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('onesearch-secret');
  });

  it('rejects an unusable DOI without fetching', async () => {
    const fetchImpl = vi.fn();
    const result = await getFullText({ doi: 'https://evil.example/10.1000/abc' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('error');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a doi or recordId', async () => {
    const result = await getFullText({}, { sessionPath: '/nonexistent/neu-session.json' });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/doi/);
  });

  it('extracts PDF text through the proxy and does not echo the session cookie', async () => {
    const fetchImpl = vi.fn(async () => pdfResponse());
    const result = await getFullText(
      { doi: 'https://doi.org/10.1371/journal.pone.0212767' },
      { fetchImpl, sessionPath: ezproxySession() }
    );

    expect(result.status).toBe('ok');
    expect(result.via).toBe('pdf');
    expect(result.doi).toBe('10.1371/journal.pone.0212767');
    expect(result.text).toContain('Hello from the proxy fixture.');
    expect(result.pageCount).toBe(2);
    expect(result.contentType).toContain('application/pdf');
    expect(JSON.stringify(result)).not.toContain(COOKIE);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://link.ezproxy.neu.edu/login?qurl=' +
        encodeURIComponent('https://doi.org/10.1371/journal.pone.0212767')
    );
    expect((init.headers as Record<string, string>).Cookie).toBe(`ezproxy=${COOKIE}`);
  });

  it('follows citation_pdf_url through EZproxy instead of the publisher host', async () => {
    const html = `<html><head>
      <meta name="citation_pdf_url" content="https://publisher.example/articles/x.pdf">
      <meta name="citation_title" content="Proxied Paper">
    </head><body><article><p>${'word '.repeat(20)}</p></article></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('publisher.example') && !url.includes('ezproxy.neu.edu')) {
        throw new Error('publisher host was contacted directly');
      }
      if (url.includes(encodeURIComponent('https://publisher.example/articles/x.pdf'))) {
        return pdfResponse();
      }
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });

    const result = await getFullText({ doi: '10.1000/xyz123' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('ok');
    expect(result.via).toBe('pdf');
    expect(result.title).toBe('Proxied Paper');
    expect(result.text).toContain('Hello from the proxy fixture.');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not fetch a citation PDF on a private host', async () => {
    const html = `<html><head><meta name="citation_pdf_url" content="http://127.0.0.1/secret.pdf"></head>
      <body><article><p>${'mitochondria '.repeat(400)}</p></article></body></html>`;
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await getFullText({ doi: '10.1000/xyz123' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.via).toBe('html');
    expect(result.status).toBe('ok');
    expect(result.text).toContain('mitochondria');
  });

  it('reports an access wall instead of calling the landing page full text', async () => {
    const html = '<html><body><p>Please purchase this article to continue.</p><p>Abstract only.</p></body></html>';
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await getFullText({ doi: '10.1000/xyz123' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('not_entitled');
    expect(result.text).toContain('Abstract only.');
    expect(result.message).toMatch(/access wall/i);
  });

  it('reports the EZproxy sign-in page when the session is rejected', async () => {
    const html = '<html><body><a href="/login?auth=shibbolethNU&url=^U">Authenticate with Northeastern credentials</a></body></html>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('login.ezproxy.neu.edu')) {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'https://login.ezproxy.neu.edu/login?url=https%3A%2F%2Fdoi.org%2F10.1000%2Fxyz123' },
      });
    });
    const result = await getFullText({ doi: '10.1000/xyz123' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('login_required');
    expect(result.text).toBeNull();
    expect(result.message).toMatch(/sign-in page/);
  });

  it('reports a landing on the EZproxy menu as an error, not login_required', async () => {
    const html = '<html><head><title>Database Menu</title></head><body>Database Menu</body></html>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).startsWith('https://login.ezproxy.neu.edu/menu')) {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response(null, { status: 302, headers: { location: 'https://login.ezproxy.neu.edu/menu' } });
    });
    const result = await getFullText({ doi: '10.1000/xyz123' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('error');
    expect(result.text).toBeNull();
    expect(result.message).toMatch(/database menu/);
    expect(result.message).not.toMatch(/sign-in page/);
  });

  describe('publishers EZproxy does not proxy', () => {
    const PLOS_DOI = '10.1371/journal.pone.0212767';
    const DX_URL = `https://dx.plos.org/${PLOS_DOI}`;
    const ARTICLE_URL = `https://journals.plos.org/plosone/article?id=${PLOS_DOI}`;
    const PDF_URL = `https://journals.plos.org/plosone/article/file?id=${PLOS_DOI}&type=printable`;
    const publicLookup = async () => ['151.101.1.1'];

    /** link -> doi-org (proxied) -> 302 dx.plos.org, then the publisher's own pages. */
    function plosFetch(publisher: (url: string) => Response) {
      return vi.fn(async (url: string, init?: RequestInit) => {
        const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
        if (url.startsWith('https://link.ezproxy.neu.edu/')) {
          return new Response(null, { status: 302, headers: { location: `https://doi-org.ezproxy.neu.edu/${PLOS_DOI}` } });
        }
        if (url.startsWith('https://doi-org.ezproxy.neu.edu/')) {
          return new Response(null, { status: 302, headers: { location: DX_URL } });
        }
        if (cookie) throw new Error(`session cookie sent to ${url}`);
        if (url === DX_URL) return new Response(null, { status: 302, headers: { location: ARTICLE_URL } });
        return publisher(url);
      });
    }

    it('fetches open-access text directly from the publisher without the session cookie', async () => {
      const html = `<html><head>
        <meta name="citation_title" content="Open Paper">
        <meta name="citation_pdf_url" content="${PDF_URL.replace(/&/g, '&amp;')}">
      </head><body><p>landing</p></body></html>`;
      const fetchImpl = plosFetch((url) =>
        url === PDF_URL ? pdfResponse() : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
      );
      const result = await getFullText(
        { doi: PLOS_DOI },
        { fetchImpl, lookupImpl: publicLookup, sessionPath: ezproxySession() }
      );
      expect(result.status).toBe('ok');
      expect(result.via).toBe('pdf');
      expect(result.title).toBe('Open Paper');
      expect(result.sourceUrl).toBe(PDF_URL);
      expect(result.text).toContain('Hello from the proxy fixture.');
      expect(result.message).toMatch(/not on NEU's EZproxy/);
      expect(JSON.stringify(result)).not.toContain(COOKIE);
    });

    it('falls back to the HTML page when the direct PDF is not a PDF', async () => {
      const html = `<html><head><meta name="citation_pdf_url" content="/plosone/article/file?id=x"></head>
        <body><article><p>${'open access body '.repeat(300)}</p></article></body></html>`;
      const fetchImpl = plosFetch((url) =>
        url.includes('/file?')
          ? new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } })
          : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
      );
      const result = await getFullText({ doi: PLOS_DOI }, { fetchImpl, lookupImpl: publicLookup, sessionPath: ezproxySession() });
      expect(result.status).toBe('ok');
      expect(result.via).toBe('html');
      expect(result.sourceUrl).toBe(ARTICLE_URL);
      expect(result.text).toContain('open access body');
      expect(result.message).toMatch(/not on NEU's EZproxy/);
      expect(result.message).not.toMatch(/through EZproxy/);
    });

    it('returns not_proxied with the publisher URL when the direct fetch is refused', async () => {
      const fetchImpl = plosFetch(() => new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } }));
      const result = await getFullText({ doi: PLOS_DOI }, { fetchImpl, lookupImpl: publicLookup, sessionPath: ezproxySession() });
      expect(result.status).toBe('not_proxied');
      expect(result.text).toBeNull();
      expect(result.sourceUrl).toBe(DX_URL);
      expect(result.readUrl).toBe(DX_URL);
      expect(result.message.split(DX_URL).length - 1).toBe(1);
      expect(result.message).toMatch(/signing in again will not help/i);
      expect(result.message).toMatch(/HTTP 404/);
      expect(result.message).not.toMatch(/Re-run/);
      expect(JSON.stringify(result)).not.toContain(COOKIE);
    });

    it('does not fetch a publisher host that resolves to a private address', async () => {
      const fetchImpl = plosFetch(() => {
        throw new Error('private publisher host was contacted');
      });
      const result = await getFullText(
        { doi: PLOS_DOI },
        { fetchImpl, lookupImpl: async () => ['192.168.0.10'], sessionPath: ezproxySession() }
      );
      expect(result.status).toBe('not_proxied');
      expect(result.sourceUrl).toBe(DX_URL);
      expect(result.message).toMatch(/private address/);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  it('still reports login_required when EZproxy redirects to the NEU IdP', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('neuidmsso.neu.edu')) throw new Error('IdP was contacted');
      return new Response(null, { status: 302, headers: { location: 'https://neuidmsso.neu.edu/idp/profile/SAML2/Redirect/SSO' } });
    });
    const result = await getFullText({ doi: '10.1000/xyz123' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('login_required');
    expect(result.message).toMatch(/NU IT sign-in/);
  });

  it('reports login_required when EZproxy redirects to Microsoft sign-in, without fetching it', async () => {
    const entra =
      'https://login.microsoftonline.com/a8eec281-aaa3-4dae-ac9b-9a398b9215e7/saml2?SAMLRequest=abc';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('microsoftonline.com')) throw new Error('Microsoft sign-in host was contacted');
      return new Response(null, { status: 302, headers: { location: entra } });
    });
    const lookupImpl = vi.fn(async () => {
      throw new Error('Microsoft sign-in host was resolved for a direct fetch');
    });
    const result = await getFullText({ doi: '10.1000/xyz123' }, { fetchImpl, lookupImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('login_required');
    expect(result.message).toMatch(/NU IT sign-in/);
    expect(result.sourceUrl).not.toContain('microsoftonline');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lookupImpl).not.toHaveBeenCalled();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith('https://link.ezproxy.neu.edu/')).toBe(true);
    expect((init.headers as Record<string, string>).Cookie).toBe(`ezproxy=${COOKIE}`);
    expect(JSON.stringify(result)).not.toContain(COOKIE);
  });

  it('maps HTTP 403 to not entitled', async () => {
    const fetchImpl = vi.fn(async () => new Response('denied', { status: 403, headers: { 'content-type': 'text/plain' } }));
    const result = await getFullText({ doi: '10.1000/xyz123' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('not_entitled');
    expect(result.message).toContain('403');
  });

  it('truncates PDF text at the character cap and PDF pages at the page cap', async () => {
    const fetchImpl = vi.fn(async () => pdfResponse());
    const result = await getFullText(
      { doi: '10.1000/xyz123' },
      { fetchImpl, sessionPath: ezproxySession(), maxTextChars: 12, maxPdfPages: 1 }
    );
    expect(result.status).toBe('ok');
    expect(result.truncated).toBe(true);
    expect(result.text?.length).toBe(12);
    expect(result.pagesExtracted).toBe(1);
    expect(result.pageCount).toBe(2);
    expect(result.message).toMatch(/truncated/i);
  });

  it('resolves an alma recordId to its DOI without requiring the caller to pass one', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        info: { total: 1 },
        docs: [
          {
            pnx: {
              display: { title: ['Machine learning'] },
              control: { recordid: ['alma9952077153901401'] },
              addata: { doi: ['10.1007/978-981-15-1967-3'] },
            },
          },
        ],
      }),
    });
    const fetchImpl = vi.fn(async () => pdfResponse());
    const result = await getFullText(
      { recordId: 'alma9952077153901401' },
      { fetchImpl, sessionPath: ezproxySession() }
    );
    expect(result.status).toBe('ok');
    expect(result.doi).toBe('10.1007/978-981-15-1967-3');
    expect(result.title).toBe('Machine learning');
    const requested = fetchImpl.mock.calls[0][0] as string;
    expect(requested).toContain(encodeURIComponent('https://doi.org/10.1007/978-981-15-1967-3'));
  });

  it('returns login_required for a catalog record when no EZproxy session exists, and still resolves the link', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        info: { total: 1 },
        docs: [
          {
            pnx: {
              display: { title: ['Machine learning'] },
              control: { recordid: ['alma1'] },
              addata: { doi: ['10.1007/978-981-15-1967-3'] },
            },
          },
        ],
      }),
    });
    const fetchImpl = vi.fn();
    const result = await getFullText(
      { recordId: 'alma1' },
      { fetchImpl, sessionPath: '/nonexistent/neu-session.json' }
    );
    expect(result.status).toBe('login_required');
    expect(result.sourceUrl).toContain('link.ezproxy.neu.edu');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a cdi_ recordId to its DOI', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        pnx: {
          control: { recordid: ['cdi_crossref_primary_10_34028_iajit_19_2_8'] },
          addata: { doi: ['10.34028/iajit/19/2/8'] },
        },
      }),
    });
    const fetchImpl = vi.fn(async () => pdfResponse());
    const result = await getFullText(
      { recordId: 'cdi_crossref_primary_10_34028_iajit_19_2_8' },
      { fetchImpl, sessionPath: ezproxySession() }
    );
    expect(result.doi).toBe('10.34028/iajit/19/2/8');
    expect(result.status).toBe('ok');
  });

  it('cdi_ record without a DOI uses its linktopdf through EZproxy', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        pnx: {
          control: { recordid: ['cdi_proquest_journals_216114114'] },
          links: { linktopdf: ['$$Uhttps://www.proquest.com/docview/216114114/fulltextPDF?pq-origsite=primo$$EPDF$$Gproquest'] },
        },
      }),
    });
    const fetchImpl = vi.fn(async () => pdfResponse());
    await getFullText({ recordId: 'cdi_proquest_journals_216114114' }, { fetchImpl, sessionPath: ezproxySession() });
    const firstUrl = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(firstUrl.startsWith('https://link.ezproxy.neu.edu/login?qurl=')).toBe(true);
    expect(firstUrl).toContain('proquest');
  });

  it('cdi_ record with neither DOI nor link is unsupported with a clear message', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ pnx: { control: { recordid: ['cdi_x_1'] } } }),
    });
    const fetchImpl = vi.fn();
    const result = await getFullText({ recordId: 'cdi_x_1' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('unsupported');
    expect(result.message).toMatch(/no DOI or full-text link/);
  });

  it('never names get_record in a get_full_text error', async () => {
    const fetchImpl = vi.fn();
    const result = await getFullText({ recordId: 'pq_1' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('error');
    expect(result.message).not.toMatch(/get_record/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  describe('readUrl and fullText on every result', () => {
    const DOI = '10.1000/xyz123';
    const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

    it('every no-text status carries readUrl except no-target errors', async () => {
      const cases: Array<[string, () => Promise<Awaited<ReturnType<typeof getFullText>>>]> = [
        ['no session', () => getFullText({ doi: DOI }, { fetchImpl: vi.fn(), sessionPath: '/nonexistent/s.json' })],
        ['403', () => getFullText({ doi: DOI }, { fetchImpl: vi.fn(async () => new Response('no', { status: 403, headers: { 'content-type': 'text/plain' } })), sessionPath: ezproxySession() })],
        ['404', () => getFullText({ doi: DOI }, { fetchImpl: vi.fn(async () => new Response('no', { status: 404, headers: { 'content-type': 'text/plain' } })), sessionPath: ezproxySession() })],
        ['too large', () => getFullText({ doi: DOI }, { fetchImpl: vi.fn(async () => new Response('x'.repeat(100), { status: 200, headers: { 'content-type': 'text/html' } })), sessionPath: ezproxySession(), maxDownloadBytes: 10 })],
        ['unsupported type', () => getFullText({ doi: DOI }, { fetchImpl: vi.fn(async () => new Response('zip', { status: 200, headers: { 'content-type': 'application/zip' } })), sessionPath: ezproxySession() })],
        ['menu', () => getFullText({ doi: DOI }, { fetchImpl: vi.fn(async (url: string) => String(url).startsWith('https://login.ezproxy.neu.edu/menu') ? html('<html><head><title>Database Menu</title></head><body>Database Menu</body></html>') : new Response(null, { status: 302, headers: { location: 'https://login.ezproxy.neu.edu/menu' } })), sessionPath: ezproxySession() })],
      ];
      for (const [name, run] of cases) {
        const r = await run();
        expect(r.fullText, name).toBe(false);
        expect(r.readUrl, name).not.toBeNull();
        expect(r.message.startsWith('Full text was not retrieved: '), name).toBe(true);
        expect(r.message, name).toContain(`Open it in a browser: ${r.readUrl}`);
      }
    });

    it('off-proxy refusal uses the publisher URL as readUrl', async () => {
      const PUB = 'https://dx.plos.org/10.1371/journal.pone.0212767';
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.startsWith('https://link.ezproxy.neu.edu/')) {
          return new Response(null, { status: 302, headers: { location: 'https://doi-org.ezproxy.neu.edu/10.1371/journal.pone.0212767' } });
        }
        if (url.startsWith('https://doi-org.ezproxy.neu.edu/')) return new Response(null, { status: 302, headers: { location: PUB } });
        return new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } });
      });
      const r = await getFullText(
        { doi: '10.1371/journal.pone.0212767' },
        { fetchImpl, lookupImpl: async () => ['151.101.1.1'], sessionPath: ezproxySession() }
      );
      expect(r.status).toBe('not_proxied');
      expect(r.readUrl).toBe(PUB);
      expect(r.fullText).toBe(false);
      expect(r.message.split(PUB).length - 1).toBe(1);
    });

    it('marks a successful extraction as full text with no readUrl', async () => {
      const r = await getFullText({ doi: DOI }, { fetchImpl: vi.fn(async () => pdfResponse()), sessionPath: ezproxySession() });
      expect(r).toMatchObject({ status: 'ok', fullText: true, textKind: 'article', readUrl: null });
      expect(r.message.startsWith('Full text was not retrieved')).toBe(false);
    });

    it('bad DOI and no-input paths have no readUrl', async () => {
      const bad = await getFullText({ doi: 'not a doi' }, { fetchImpl: vi.fn() });
      expect(bad).toMatchObject({ status: 'error', fullText: false, readUrl: null });
      const none = await getFullText({}, { fetchImpl: vi.fn() });
      expect(none).toMatchObject({ status: 'error', fullText: false, readUrl: null });
    });
  });
});

describe('blocked status', () => {
  const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf-8');
  const htmlResponse = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const expectBlockedMessage = (message: string) => {
    expect(message).toMatch(/blocked automated access/);
    expect(message).toMatch(/browser/);
    expect(message).toMatch(/CAPTCHA/);
  };

  it('a Springer challenge page is blocked, not partial', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(fixture('challenge-springer.html')));
    const r = await getFullText({ doi: '10.1007/s42979-024-03476-y' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(r.status).toBe('blocked');
    expect(r.text).toBeNull();
    expect(r.fullText).toBe(false);
    expect(r.readUrl).toMatch(/^https:\/\/link\.ezproxy\.neu\.edu\/login\?qurl=/);
    expectBlockedMessage(r.message);
  });

  it('an IEEE challenge served as 403 is blocked, not not_entitled', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(fixture('challenge-ieee.html'), 403));
    const r = await getFullText({ doi: '10.1109/5.771073' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(r.status).toBe('blocked');
    expect(r.text).toBeNull();
    expectBlockedMessage(r.message);
  });

  it('the EZproxy interstitial is blocked and its link is not followed', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(fixture('ezproxy-interstitial.html')));
    const r = await getFullText({ doi: '10.1007/s42979-024-03476-y' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(r.status).toBe('blocked');
    expect(r.text).toBeNull();
    expectBlockedMessage(r.message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a direct 403 is blocked and does not suggest a paywall', async () => {
    const DOI = '10.3390/su16010001';
    const MDPI = 'https://www.mdpi.com/2071-1050/16/1/1';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.startsWith('https://link.ezproxy.neu.edu/')) {
        return new Response(null, { status: 302, headers: { location: `https://doi-org.ezproxy.neu.edu/${DOI}` } });
      }
      if (url.startsWith('https://doi-org.ezproxy.neu.edu/')) {
        return new Response(null, { status: 302, headers: { location: MDPI } });
      }
      return htmlResponse(fixture('mdpi-403.html'), 403);
    });
    const r = await getFullText({ doi: DOI }, { fetchImpl, lookupImpl: async () => ['151.101.1.1'], sessionPath: ezproxySession() });
    expect(r.status).toBe('blocked');
    expect(r.text).toBeNull();
    expect(r.message).not.toMatch(/open access|paywall|subscri/i);
    expectBlockedMessage(r.message);
    expect(r.readUrl).toBe(MDPI);
    expect(r.message.split(MDPI).length - 1).toBe(1);
  });
});

describe('Elsevier linkinghub redirect and abstract-only pages', () => {
  const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf-8');
  const htmlResponse = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
  const DOI = '10.1016/j.cose.2025.104509';
  const HUB = 'https://linkinghub-elsevier-com.ezproxy.neu.edu/retrieve/pii/S0167404825001981';
  const SD = 'https://www-sciencedirect-com.ezproxy.neu.edu/science/article/pii/S0167404825001981';
  const abstractOnly = fixture('elsevier-abstract-only.html');
  const fullBody = abstractOnly.replace(
    '<section id="da1">',
    `<div id="body" class="Body"><section id="sec1"><h2>1. Introduction</h2><p>${'Synthetic body text. '.repeat(1500)}</p></section></div><section id="da1">`
  );

  /** link (DOI) -> linkinghub page; link (ScienceDirect qurl) -> proxied ScienceDirect page. */
  function elsevierFetch(sciencedirect: () => Response) {
    return vi.fn(async (url: string) => {
      if (url.startsWith('https://link.ezproxy.neu.edu/') && url.includes('sciencedirect')) {
        return new Response(null, { status: 302, headers: { location: SD } });
      }
      if (url.startsWith('https://link.ezproxy.neu.edu/')) {
        return new Response(null, { status: 302, headers: { location: HUB } });
      }
      if (url === HUB) {
        return htmlResponse(fixture('elsevier-linkinghub.html'), {
          'set-cookie': 'hub=from-linkinghub; Domain=.ezproxy.neu.edu; Path=/',
        });
      }
      if (url === SD) return sciencedirect();
      throw new Error(`unexpected request ${url}`);
    });
  }

  it('follows the Elsevier linkinghub redirect instead of returning "Redirecting"', async () => {
    const fetchImpl = elsevierFetch(() => htmlResponse(fullBody));
    const r = await getFullText({ doi: DOI }, { fetchImpl, sessionPath: ezproxySession() });
    expect(r.status).toBe('ok');
    expect(r.text).not.toBe('Redirecting');
    expect(r.text).toContain('Synthetic body text.');
    expect(r.sourceUrl).toBe(SD);

    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    const hubIndex = urls.indexOf(HUB);
    expect(hubIndex).toBeGreaterThanOrEqual(0);
    expect(urls[hubIndex + 1]).toContain('sciencedirect');
    expect(urls[hubIndex + 1]).toMatch(/^https:\/\/link\.ezproxy\.neu\.edu\/login\?qurl=/);
    const hopInit = fetchImpl.mock.calls[hubIndex + 1][1] as RequestInit;
    expect((hopInit.headers as Record<string, string>).Cookie).toContain('hub=from-linkinghub');
  });

  it('the linkinghub hop counts toward maxRedirects', async () => {
    const fetchImpl = elsevierFetch(() => htmlResponse(fullBody));
    const r = await getFullText({ doi: DOI }, { fetchImpl, sessionPath: ezproxySession(), maxRedirects: 1 });
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/Stopped after 1 proxy redirects/);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).not.toContain(SD);
  });

  it('an abstract-only page is partial with textKind abstract and the abstract prefix', async () => {
    const fetchImpl = elsevierFetch(() => htmlResponse(abstractOnly));
    const r = await getFullText({ doi: DOI }, { fetchImpl, sessionPath: ezproxySession() });
    expect(r.status).toBe('partial');
    expect(r.fullText).toBe(false);
    expect(r.textKind).toBe('abstract');
    expect(r.text).toContain('This synthetic abstract sentence');
    expect(r.message.startsWith('Abstract only. Full text was not retrieved: ')).toBe(true);
    expect(r.readUrl).toMatch(/^https:\/\/link\.ezproxy\.neu\.edu\/login\?qurl=/);
  });

  it('a failed PDF hop that lands on an abstract page is not ok', async () => {
    const abstractPage = `<html><head><meta name="citation_pdf_url" content="https://publisher.example/a.pdf"></head>
      <body><main><h1>A Title</h1><h2>Abstract</h2><p>${'An invented abstract sentence for the fallback case. '.repeat(55)}</p>
      <p>Cite this article</p></main></body></html>`;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes(encodeURIComponent('https://publisher.example/a.pdf'))) {
        return htmlResponse('<html><body><p>Download failed.</p></body></html>');
      }
      return htmlResponse(abstractPage);
    });
    const r = await getFullText({ doi: '10.1000/abstract1' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.charCount).toBeGreaterThanOrEqual(2500);
    expect(r.status).not.toBe('ok');
    expect(r.status).toBe('partial');
    expect(r.textKind).toBe('abstract');
  });
});

describe('overall deadline', () => {
  it('a call that outlives the deadline still returns readUrl', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
    const result = await getFullText(
      { doi: '10.1371/journal.pone.0212767' },
      { fetchImpl, sessionPath: ezproxySession(), deadlineMs: 50 }
    );
    expect(result.status).toBe('error');
    expect(result.readUrl).not.toBeNull();
    expect(result.message).toMatch(/Timed out after 50ms/);
  });
});
