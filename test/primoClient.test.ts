import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFacetClause, buildSearchParams, searchOneSearch, getRecord } from '../src/primoClient.js';
import * as sessionModule from '../src/session.js';

beforeEach(() => {
  vi.spyOn(sessionModule, 'loadSession').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildFacetClause', () => {
  it('returns an empty string when no filters are provided', () => {
    expect(buildFacetClause({ query: 'test' })).toBe('');
  });

  it('builds a resourceType facet clause', () => {
    expect(buildFacetClause({ query: 'test', resourceType: 'articles' })).toBe('facet_rtype,include,articles');
  });

  it('builds a peer-reviewed facet clause', () => {
    expect(buildFacetClause({ query: 'test', peerReviewedOnly: true })).toBe('facet_tlevel,include,peer_reviewed');
  });

  it('builds a date range facet clause', () => {
    expect(buildFacetClause({ query: 'test', dateFrom: 2020, dateTo: 2023 })).toBe(
      'facet_searchcreationdate,include,[2020 TO 2023]'
    );
  });

  it('throws when more than one filter is requested at once', () => {
    expect(() =>
      buildFacetClause({ query: 'test', resourceType: 'articles', peerReviewedOnly: true })
    ).toThrow(/only supports one filter/);
  });
});

describe('buildSearchParams', () => {
  it('builds params with defaults', () => {
    const params = buildSearchParams({ query: 'machine learning' });
    expect(params.get('q')).toBe('any,contains,machine learning');
    expect(params.get('limit')).toBe('10');
    expect(params.get('sort')).toBe('rank');
    expect(params.get('skipDelivery')).toBe('N');
    expect(params.get('vid')).toBe('01NEU_INST:NUL');
  });

  it('caps limit at 50', () => {
    const params = buildSearchParams({ query: 'x', limit: 500 });
    expect(params.get('limit')).toBe('50');
  });

  it('floors limit at 1', () => {
    const params = buildSearchParams({ query: 'x', limit: 0 });
    expect(params.get('limit')).toBe('1');
  });
});

describe('buildSearchParams campus scope', () => {
  it('defaults to the all-campus scope', () => {
    const params = buildSearchParams({ query: 'x' });
    expect(params.get('tab')).toBe('Everything');
    expect(params.get('scope')).toBe('CDI_plus_all_local');
  });

  it('builds the Boston campus scope', () => {
    const params = buildSearchParams({ query: 'x', campus: 'boston' });
    expect(params.get('tab')).toBe('Boston');
    expect(params.get('scope')).toBe('MyInst_and_CI');
  });

  it('builds the Oakland campus scope', () => {
    const params = buildSearchParams({ query: 'x', campus: 'oakland' });
    expect(params.get('tab')).toBe('Oakland');
    expect(params.get('scope')).toBe('Mills_and_CI');
  });

  it('builds the Online-only campus scope', () => {
    const params = buildSearchParams({ query: 'x', campus: 'online' });
    expect(params.get('tab')).toBe('Online');
    expect(params.get('scope')).toBe('CDI_and_EResources');
  });

  it('builds the all-campus scope explicitly', () => {
    const params = buildSearchParams({ query: 'x', campus: 'all' });
    expect(params.get('tab')).toBe('Everything');
    expect(params.get('scope')).toBe('CDI_plus_all_local');
  });
});

describe('getRecord campus scope', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always uses the all-campus scope regardless of any campus preference', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 1 }, docs: [{ pnx: { control: { recordid: ['alma1'] } } }] }),
    });
    await getRecord('alma1');
    const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('tab=Everything');
    expect(calledUrl).toContain('scope=CDI_plus_all_local');
  });
});

describe('searchOneSearch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON on success', async () => {
    const mockResponse = { info: { total: 1 }, docs: [] };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    const result = await searchOneSearch({ query: 'test' });
    expect(result).toEqual(mockResponse);
  });

  it('throws a clear error on a non-200 response', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });
    await expect(searchOneSearch({ query: 'test' })).rejects.toThrow('OneSearch request failed: HTTP 503');
  });
});

describe('getRecord', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects record ids that do not start with "alma"', async () => {
    await expect(getRecord('cdi_something')).rejects.toThrow(/only supports Northeastern catalog records/);
  });

  it('builds an mms_id query and returns the first doc', async () => {
    const doc = { pnx: { control: { recordid: ['alma123'] } } };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 1 }, docs: [doc] }),
    });
    const result = await getRecord('alma123');
    expect(result).toEqual(doc);
    const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent('mms_id,exact,123'));
  });

  it('returns null when no doc is found', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });
    const result = await getRecord('alma999');
    expect(result).toBeNull();
  });

  it('returns null defensively when docs field is missing', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 } }),
    });
    const result = await getRecord('alma999');
    expect(result).toBeNull();
  });
});

describe('fetchPrimo', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws clear error when response.json() fails', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    await expect(searchOneSearch({ query: 'test' })).rejects.toThrow(
      'OneSearch returned an unparseable response'
    );
  });
});

describe('fetchPrimo cookie attachment', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches a Cookie header when a session is present', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue('JSESSIONID=abc123');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    await searchOneSearch({ query: 'test' });

    const options = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    expect(options?.headers).toEqual({ Cookie: 'JSESSIONID=abc123' });
  });

  it('sends no Cookie header when no session is present', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue(null);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    await searchOneSearch({ query: 'test' });

    const options = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    expect(options?.headers).toBeUndefined();
  });

  it('attaches the Cookie header on getRecord requests too', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue('JSESSIONID=abc123');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    await getRecord('alma1');

    const options = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    expect(options?.headers).toEqual({ Cookie: 'JSESSIONID=abc123' });
  });
});

describe('fetchPrimo login_required detection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('throws LoginRequiredError on a 401 when a session was attached', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue('JSESSIONID=abc123');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      url: 'https://onesearch.library.northeastern.edu/primaws/x',
      redirected: false,
      json: async () => ({}),
    });
    await expect(searchOneSearch({ query: 'test' })).rejects.toThrow(/session is missing or expired/);
  });

  it('throws LoginRequiredError when redirected to an SSO host with a session', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue('JSESSIONID=abc123');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://neuidmsso.neu.edu/idp/profile/SAML2',
      redirected: true,
      json: async () => ({}),
    });
    await expect(searchOneSearch({ query: 'test' })).rejects.toThrow(/session is missing or expired/);
  });

  it('does not raise login_required for an anonymous (no-session) request', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue(null);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      url: 'https://onesearch.library.northeastern.edu/primaws/x',
      redirected: false,
      json: async () => ({}),
    });
    // Anonymous: a 403 is a plain request failure, not a login prompt.
    await expect(searchOneSearch({ query: 'test' })).rejects.toThrow('OneSearch request failed: HTTP 403');
  });
});
