import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOpenAccessCopies, tryOpenAccess, type OaCopy } from '../src/openAccess.js';
import type { Deadline } from '../src/deadline.js';

const fixturePdf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tiny.pdf'));
const DOI = '10.1007/s10462-024-10827-x';
const publicLookup = async () => ['151.101.1.1'];
const LIMITS = { maxPdfPages: 40, maxTextChars: 100_000 };

interface Location {
  pdf_url: string | null;
  version?: string | null;
  source?: { display_name?: string } | null;
}

function openAlexResponse(locations: Location[]): Response {
  return new Response(JSON.stringify({ id: 'https://openalex.org/W1', locations }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function openAlexFetchFor(locations: Location[]) {
  return vi.fn(async (_url: string, _init?: RequestInit) => openAlexResponse(locations));
}

function pdfResponse(): Response {
  return new Response(fixturePdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
}

function htmlResponse(body = '<html><body><p>Repository landing page</p></body></html>'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function deadlineWith(ms: number): Deadline {
  return { remainingMs: () => ms, expired: () => ms <= 0 };
}

function headerNames(init: RequestInit | undefined): string[] {
  const headers = init?.headers;
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.keys()];
  if (Array.isArray(headers)) return headers.map(([name]) => name.toLowerCase());
  return Object.keys(headers).map((name) => name.toLowerCase());
}

describe('findOpenAccessCopies', () => {
  it('maps locations with a pdf_url, sorts published, accepted, submitted, unknown, and dedupes', async () => {
    const openAlexFetch = openAlexFetchFor([
      { pdf_url: 'https://repo.example/unknown.pdf', version: null, source: null },
      { pdf_url: 'https://arxiv.example/submitted.pdf', version: 'submittedVersion', source: { display_name: 'arXiv' } },
      { pdf_url: null, version: 'publishedVersion', source: { display_name: 'Journal (no pdf)' } },
      { pdf_url: 'https://repo.example/accepted.pdf', version: 'acceptedVersion', source: { display_name: 'Repo' } },
      { pdf_url: 'https://publisher.example/published.pdf', version: 'publishedVersion', source: { display_name: 'Journal' } },
      { pdf_url: 'https://repo.example/accepted.pdf', version: 'acceptedVersion', source: { display_name: 'Mirror' } },
      { pdf_url: 'https://other.example/odd.pdf', version: 'someOtherVersion' },
    ]);

    const copies = await findOpenAccessCopies(DOI, openAlexFetch);
    expect(copies).toEqual<OaCopy[]>([
      { pdfUrl: 'https://publisher.example/published.pdf', version: 'published', repository: 'Journal' },
      { pdfUrl: 'https://repo.example/accepted.pdf', version: 'accepted', repository: 'Repo' },
      { pdfUrl: 'https://arxiv.example/submitted.pdf', version: 'submitted', repository: 'arXiv' },
      { pdfUrl: 'https://repo.example/unknown.pdf', version: 'unknown', repository: null },
      { pdfUrl: 'https://other.example/odd.pdf', version: 'unknown', repository: null },
    ]);
  });

  it('calls the keyless OpenAlex works endpoint with the DOI percent-encoded', async () => {
    const odd = '10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0';
    const openAlexFetch = openAlexFetchFor([]);
    await findOpenAccessCopies(odd, openAlexFetch);
    expect(openAlexFetch).toHaveBeenCalledTimes(1);
    const [url, init] = openAlexFetch.mock.calls[0];
    expect(url).toBe(`https://api.openalex.org/works/doi:${encodeURIComponent(odd)}`);
    expect(url).not.toMatch(/[<>;]/); // encodeURIComponent keeps ( ) as-is, which is valid in a path
    expect(url).not.toMatch(/mailto|api_key/);
    expect(headerNames(init)).not.toContain('cookie');
  });

  it('returns [] for a 500, a non-JSON body, or a thrown error', async () => {
    const failing = [
      vi.fn(async () => new Response('oops', { status: 500 })),
      vi.fn(async () => new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } })),
      vi.fn(async () => {
        throw new Error('network down');
      }),
      vi.fn(async () => undefined as unknown as Response),
      vi.fn(async () => new Response(JSON.stringify({ locations: 'nope' }), { status: 200 })),
    ];
    for (const openAlexFetch of failing) {
      await expect(findOpenAccessCopies(DOI, openAlexFetch)).resolves.toEqual([]);
    }
  });
});

describe('tryOpenAccess', () => {
  it('returns the first copy that extracts, with an ok result naming the repository and version', async () => {
    const pdfUrl = 'https://eprints.whiterose.ac.uk/id/eprint/222127/1/s10462-024-10827-x.pdf';
    const openAlexFetch = openAlexFetchFor([
      { pdf_url: pdfUrl, version: 'submittedVersion', source: { display_name: 'White Rose Research Online' } },
    ]);
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => pdfResponse());
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(60_000),
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out.copy).toEqual({ pdfUrl, version: 'submitted', repository: 'White Rose Research Online' });
    if (out.copy === null) return;
    expect(out.result.status).toBe('ok');
    expect(out.result.version).toBe('submitted');
    expect(out.result.sourceUrl).toBe(pdfUrl);
    expect(out.result.via).toBe('pdf');
    expect(out.result.text).toContain('Hello from the proxy fixture.');
    expect(out.result.message).toContain('White Rose Research Online');
    expect(out.result.message).toMatch(/submitted/);
    expect(out.result.message).toMatch(/not the published version/);
  });

  it('skips the host that just blocked us', async () => {
    const openAlexFetch = openAlexFetchFor([
      { pdf_url: 'https://www.mdpi.com/2071-1050/16/1/1/pdf', version: 'publishedVersion', source: { display_name: 'MDPI' } },
      { pdf_url: 'https://repo.example/accepted.pdf', version: 'acceptedVersion', source: { display_name: 'Repo' } },
    ]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('mdpi.com')) throw new Error('the blocking host was contacted again');
      return pdfResponse();
    });
    const out = await tryOpenAccess(DOI, {
      skipHost: 'www.mdpi.com',
      deadline: deadlineWith(60_000),
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out.copy?.pdfUrl).toBe('https://repo.example/accepted.pdf');
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual(['https://repo.example/accepted.pdf']);
  });

  it('stops after 3 copies', async () => {
    const openAlexFetch = openAlexFetchFor(
      [1, 2, 3, 4, 5].map((n) => ({ pdf_url: `https://repo${n}.example/paper.pdf`, version: 'acceptedVersion' }))
    );
    const fetchImpl = vi.fn(async () => new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(60_000),
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out.copy).toBeNull();
    if (out.copy !== null) return;
    expect(out.tried).toBe(3);
    expect(out.firstUnextractable).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('skips a copy whose pdf_url answers with HTML and takes the next one, without retrying it', async () => {
    const landing = 'https://repo.example/record/42.pdf';
    const good = 'https://arxiv.example/pdf/42.pdf';
    const openAlexFetch = openAlexFetchFor([
      { pdf_url: landing, version: 'acceptedVersion', source: { display_name: 'Landing Repo' } },
      { pdf_url: good, version: 'submittedVersion', source: { display_name: 'arXiv' } },
    ]);
    const fetchImpl = vi.fn(async (url: string) => (url === landing ? htmlResponse() : pdfResponse()));
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(60_000),
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out.copy?.pdfUrl).toBe(good);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([landing, good]);
  });

  it('reports the first copy that answered but could not be extracted', async () => {
    const landing = 'https://repo.example/record/42.pdf';
    const openAlexFetch = openAlexFetchFor([{ pdf_url: landing, version: 'acceptedVersion' }]);
    const fetchImpl = vi.fn(async () => htmlResponse());
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(60_000),
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out.copy).toBeNull();
    if (out.copy !== null) return;
    expect(out.tried).toBe(1);
    expect(out.firstUnextractable?.pdfUrl).toBe(landing);
  });

  it('refuses a pdf_url on a private address and takes the next one', async () => {
    const good = 'https://repo.example/paper.pdf';
    const openAlexFetch = openAlexFetchFor([
      { pdf_url: 'http://127.0.0.1/secret.pdf', version: 'publishedVersion' },
      { pdf_url: good, version: 'acceptedVersion' },
    ]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('127.0.0.1')) throw new Error('private host was contacted');
      return pdfResponse();
    });
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(60_000),
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out.copy?.pdfUrl).toBe(good);
    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([good]);
  });

  it('sends no Cookie header to OpenAlex or to any copy host', async () => {
    const openAlexFetch = openAlexFetchFor([
      { pdf_url: 'https://repo1.example/a.pdf', version: 'publishedVersion' },
      { pdf_url: 'https://repo2.example/b.pdf', version: 'acceptedVersion' },
      { pdf_url: 'https://repo3.example/c.pdf', version: 'submittedVersion' },
    ]);
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('repo1')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/a.pdf' } });
      if (url.includes('repo3')) return pdfResponse();
      return htmlResponse();
    });
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(60_000),
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out.copy?.pdfUrl).toBe('https://repo3.example/c.pdf');
    const calls = [...openAlexFetch.mock.calls, ...fetchImpl.mock.calls] as Array<[string, RequestInit | undefined]>;
    expect(calls.length).toBe(5);
    for (const [url, init] of calls) {
      expect(headerNames(init), url).not.toContain('cookie');
    }
  });

  it('does not call OpenAlex when less than 10 seconds remain', async () => {
    const openAlexFetch = openAlexFetchFor([{ pdf_url: 'https://repo.example/a.pdf', version: 'publishedVersion' }]);
    const fetchImpl = vi.fn(async () => pdfResponse());
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(9_999),
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out).toMatchObject({ copy: null, tried: 0, skipped: true });
    expect(openAlexFetch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops trying copies once less than 10 seconds remain', async () => {
    let remaining = 30_000;
    const deadline: Deadline = { remainingMs: () => remaining, expired: () => remaining <= 0 };
    const openAlexFetch = openAlexFetchFor([
      { pdf_url: 'https://repo1.example/a.pdf', version: 'publishedVersion' },
      { pdf_url: 'https://repo2.example/b.pdf', version: 'acceptedVersion' },
    ]);
    const fetchImpl = vi.fn(async () => {
      remaining = 5_000;
      return new Response('gone', { status: 404 });
    });
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline,
      fetchImpl,
      openAlexFetch,
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out.copy).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('marks the search skipped when OpenAlex fails', async () => {
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(60_000),
      fetchImpl: vi.fn(),
      openAlexFetch: vi.fn(async () => new Response('oops', { status: 503 })),
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out).toMatchObject({ copy: null, tried: 0, firstUnextractable: null, skipped: true });
  });

  it('is not skipped when OpenAlex answers with no copies', async () => {
    const out = await tryOpenAccess(DOI, {
      skipHost: null,
      deadline: deadlineWith(60_000),
      fetchImpl: vi.fn(),
      openAlexFetch: openAlexFetchFor([{ pdf_url: null, version: 'publishedVersion' }]),
      lookupImpl: publicLookup,
      ...LIMITS,
    });
    expect(out).toMatchObject({ copy: null, tried: 0, firstUnextractable: null, skipped: false });
  });
});
