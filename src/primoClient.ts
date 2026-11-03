import type { PrimoDoc, PrimoSearchResponse, SearchOneSearchParams } from './types.js';
import { loadSession } from './session.js';
import { isLoginRedirect, LoginRequiredError } from './auth.js';

const BASE_URL = 'https://onesearch.library.northeastern.edu/primaws/rest/pub/pnxs';
const INST = '01NEU_INST';
const VID = '01NEU_INST:NUL';

export const CAMPUS_SCOPES: Record<'all' | 'boston' | 'oakland' | 'online', { tab: string; scope: string }> = {
  all: { tab: 'Everything', scope: 'CDI_plus_all_local' },
  boston: { tab: 'Boston', scope: 'MyInst_and_CI' },
  oakland: { tab: 'Oakland', scope: 'Mills_and_CI' },
  online: { tab: 'Online', scope: 'CDI_and_EResources' },
};

/** A hung Primo call must not stall get_full_text: its record lookup runs before the overall cap. */
const PRIMO_TIMEOUT_MS = 20_000;
const PRIMO_TIMEOUT_MESSAGE = `OneSearch did not answer within ${PRIMO_TIMEOUT_MS / 1000} seconds.`;

function isTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

async function fetchPrimoJson<T>(url: string, opts: { nullOn404?: boolean } = {}): Promise<T | null> {
  const cookie = loadSession();
  let response: Response;
  try {
    response = await fetch(url, {
      ...(cookie ? { headers: { Cookie: cookie } } : {}),
      signal: AbortSignal.timeout(PRIMO_TIMEOUT_MS),
    });
  } catch (err) {
    throw isTimeout(err) ? new Error(PRIMO_TIMEOUT_MESSAGE) : err;
  }
  // When we attached a session and the server bounced us to sign in (or
  // rejected the cookie), surface that as login_required rather than a generic
  // failure or a silently empty result.
  if (cookie && isLoginRedirect(response)) {
    throw new LoginRequiredError();
  }
  if (opts.nullOn404 && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`OneSearch request failed: HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch (err) {
    // The same signal also bounds the body download.
    throw new Error(isTimeout(err) ? PRIMO_TIMEOUT_MESSAGE : 'OneSearch returned an unparseable response');
  }
}

async function fetchPrimo(params: URLSearchParams): Promise<PrimoSearchResponse> {
  return (await fetchPrimoJson<PrimoSearchResponse>(`${BASE_URL}?${params.toString()}`)) as PrimoSearchResponse;
}

export function buildFacetClause(params: SearchOneSearchParams): string {
  const clauses: string[] = [];
  if (params.resourceType !== undefined) {
    clauses.push(`facet_rtype,include,${params.resourceType}`);
  }
  if (params.dateFrom !== undefined || params.dateTo !== undefined) {
    const from = params.dateFrom ?? 1000;
    const to = params.dateTo ?? new Date().getFullYear();
    clauses.push(`facet_searchcreationdate,include,[${from} TO ${to}]`);
  }
  if (params.peerReviewedOnly === true) {
    clauses.push('facet_tlevel,include,peer_reviewed');
  }
  return clauses.join('|,|');
}

export function buildSearchParams(params: SearchOneSearchParams): URLSearchParams {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const { tab, scope } = CAMPUS_SCOPES[params.campus ?? 'all'];

  return new URLSearchParams({
    inst: INST,
    lang: 'en',
    limit: String(limit),
    mode: 'advanced',
    offset: '0',
    pcAvailability: 'false',
    q: `any,contains,${params.query}`,
    qExclude: '',
    qInclude: buildFacetClause(params),
    scope,
    skipDelivery: 'N',
    sort: params.sort ?? 'rank',
    tab,
    vid: VID,
  });
}

export async function searchOneSearch(params: SearchOneSearchParams): Promise<PrimoSearchResponse> {
  return fetchPrimo(buildSearchParams(params));
}

async function getCdiRecord(recordId: string): Promise<PrimoDoc | null> {
  const params = new URLSearchParams({
    inst: INST,
    lang: 'en',
    vid: VID,
    search_scope: CAMPUS_SCOPES.all.scope,
    adaptor: 'Primo Central',
  });
  return fetchPrimoJson<PrimoDoc>(`${BASE_URL}/CDI/${encodeURIComponent(recordId)}?${params.toString()}`, {
    nullOn404: true,
  });
}

export async function getRecord(recordId: string): Promise<PrimoDoc | null> {
  if (recordId.startsWith('cdi_')) {
    return getCdiRecord(recordId);
  }
  if (!recordId.startsWith('alma')) {
    throw new Error(
      `Unsupported record id "${recordId}". Use a recordId from search_onesearch: it starts with "alma" (catalog) or "cdi_" (Central Discovery Index).`
    );
  }
  const mmsId = recordId.slice('alma'.length);
  const { tab, scope } = CAMPUS_SCOPES.all;
  const params = new URLSearchParams({
    inst: INST,
    lang: 'en',
    limit: '1',
    mode: 'advanced',
    offset: '0',
    pcAvailability: 'false',
    q: `mms_id,exact,${mmsId}`,
    qExclude: '',
    qInclude: '',
    scope,
    skipDelivery: 'N',
    sort: 'rank',
    tab,
    vid: VID,
  });
  const response = await fetchPrimo(params);
  return response.docs?.[0] ?? null;
}
