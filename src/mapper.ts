import type { PrimoDoc, PrimoSearchResponse, MappedResult, SearchOneSearchResult, SearchOneSearchParams } from './types.js';
import { CAMPUS_SCOPES } from './primoClient.js';

const CATALOG_BASE_URL = 'https://onesearch.library.northeastern.edu/discovery/fulldisplay';
const VID = '01NEU_INST:NUL';
const EZPROXY_DOI_BASE_URL = 'https://doi-org.ezproxy.neu.edu';

function first(values: string[] | undefined | null): string | null {
  return values && values.length > 0 ? values[0] : null;
}

function stripPrimoMarkup(value: string): string {
  const idx = value.indexOf('$$');
  return idx === -1 ? value : value.slice(0, idx).trim();
}

function buildCatalogUrl(recordId: string, campus: NonNullable<SearchOneSearchParams['campus']>): string {
  const { tab, scope } = CAMPUS_SCOPES[campus];
  const params = new URLSearchParams({
    docid: recordId,
    context: 'L',
    vid: VID,
    lang: 'en',
    search_scope: scope,
    adaptor: 'Local Search Engine',
    tab,
  });
  return `${CATALOG_BASE_URL}?${params.toString()}`;
}

export function parsePrimoLink(raw: string): string | null {
  const start = raw.indexOf('$$U');
  if (start === -1) return null;
  const rest = raw.slice(start + 3);
  const end = rest.indexOf('$$');
  const value = end === -1 ? rest : rest.slice(0, end);
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function findFullTextUrl(doc: PrimoDoc): string | null {
  const links = doc.delivery?.link ?? [];
  const fullText = links.find((link) => link.linkType === 'linktorsrc');
  if (fullText) return fullText.linkURL;
  const pnxLinks = doc.pnx.links;
  for (const key of ['linktopdf', 'linktohtml', 'linktorsrc'] as const) {
    for (const raw of pnxLinks?.[key] ?? []) {
      const parsed = parsePrimoLink(raw);
      if (parsed) return parsed;
    }
  }
  return null;
}

function buildDoiUrl(doi: string | null): string | null {
  return doi ? `https://doi.org/${doi}` : null;
}

function buildEzproxyDoiUrl(doi: string | null): string | null {
  return doi ? `${EZPROXY_DOI_BASE_URL}/${doi}` : null;
}

export function mapDoc(doc: PrimoDoc, campus: SearchOneSearchParams['campus'] = 'all'): MappedResult {
  const recordId = first(doc.pnx.control?.recordid) ?? '';
  const display = doc.pnx.display ?? {};
  const addata = doc.pnx.addata ?? {};
  const authors = addata.au ?? (display.creator ?? []).map(stripPrimoMarkup);
  const doi = first(addata.doi);

  return {
    recordId,
    title: first(display.title) ?? 'Untitled',
    authors,
    type: first(display.type),
    date: first(display.creationdate),
    publisher: first(display.publisher),
    isbn: addata.isbn ?? [],
    issn: addata.issn ?? [],
    doi,
    description: first(display.description),
    contents: first(display.contents),
    availability: doc.delivery?.displayedAvailability ?? null,
    fullTextUrl: findFullTextUrl(doc),
    catalogUrl: recordId ? buildCatalogUrl(recordId, campus) : '',
    doiUrl: buildDoiUrl(doi),
    ezproxyDoiUrl: buildEzproxyDoiUrl(doi),
  };
}

export function mapSearchResponse(
  response: PrimoSearchResponse,
  campus: SearchOneSearchParams['campus'] = 'all'
): SearchOneSearchResult {
  return {
    totalResults: response.info?.total ?? 0,
    results: (response.docs ?? []).map((doc) => mapDoc(doc, campus)),
  };
}
