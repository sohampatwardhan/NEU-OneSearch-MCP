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

  it('rejects a non-alma record id the same way get_record does', async () => {
    const fetchImpl = vi.fn();
    const result = await getFullText({ recordId: 'cdi_foo' }, { fetchImpl, sessionPath: ezproxySession() });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/alma/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
