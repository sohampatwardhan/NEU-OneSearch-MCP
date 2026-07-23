import type { PrimoDoc, PrimoSearchResponse, SearchOneSearchParams } from './types.js';

const BASE_URL = 'https://onesearch.library.northeastern.edu/primaws/rest/pub/pnxs';
const INST = '01NEU_INST';
const SCOPE = 'MyInst_and_CI';
const TAB = 'Everything';
const VID = '01NEU_INST:NUL';

async function fetchPrimo(params: URLSearchParams): Promise<PrimoSearchResponse> {
  const response = await fetch(`${BASE_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`OneSearch request failed: HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as PrimoSearchResponse;
  } catch {
    throw new Error('OneSearch returned an unparseable response');
  }
}

export function buildFacetClause(params: SearchOneSearchParams): string {
  const hasResourceType = params.resourceType !== undefined;
  const hasDateRange = params.dateFrom !== undefined || params.dateTo !== undefined;
  const hasPeerReviewed = params.peerReviewedOnly === true;
  const facetCount = [hasResourceType, hasDateRange, hasPeerReviewed].filter(Boolean).length;

  if (facetCount > 1) {
    throw new Error(
      'OneSearch only supports one filter per search: resourceType, a date range, or peerReviewedOnly. Please provide only one.'
    );
  }

  if (hasResourceType) {
    return `facet_rtype,include,${params.resourceType}`;
  }
  if (hasDateRange) {
    const from = params.dateFrom ?? 1000;
    const to = params.dateTo ?? new Date().getFullYear();
    return `facet_searchcreationdate,include,[${from} TO ${to}]`;
  }
  if (hasPeerReviewed) {
    return 'facet_tlevel,include,peer_reviewed';
  }
  return '';
}

export function buildSearchParams(params: SearchOneSearchParams): URLSearchParams {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);

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
    scope: SCOPE,
    skipDelivery: 'N',
    sort: params.sort ?? 'rank',
    tab: TAB,
    vid: VID,
  });
}

export async function searchOneSearch(params: SearchOneSearchParams): Promise<PrimoSearchResponse> {
  return fetchPrimo(buildSearchParams(params));
}

export async function getRecord(recordId: string): Promise<PrimoDoc | null> {
  if (!recordId.startsWith('alma')) {
    throw new Error(
      `get_record only supports Northeastern catalog records (recordId starting with "alma"), received: ${recordId}`
    );
  }
  const mmsId = recordId.slice('alma'.length);
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
    scope: SCOPE,
    skipDelivery: 'N',
    sort: 'rank',
    tab: TAB,
    vid: VID,
  });
  const response = await fetchPrimo(params);
  return response.docs?.[0] ?? null;
}
