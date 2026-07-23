import type { PrimoDoc, PrimoSearchResponse, MappedResult, SearchOneSearchResult } from './types.js';

const CATALOG_BASE_URL = 'https://onesearch.library.northeastern.edu/discovery/fulldisplay';
const VID = '01NEU_INST:NUL';
const SCOPE = 'MyInst_and_CI';

function first(values: string[] | undefined | null): string | null {
  return values && values.length > 0 ? values[0] : null;
}

function stripPrimoMarkup(value: string): string {
  const idx = value.indexOf('$$');
  return idx === -1 ? value : value.slice(0, idx).trim();
}

function buildCatalogUrl(recordId: string): string {
  const params = new URLSearchParams({
    docid: recordId,
    context: 'L',
    vid: VID,
    lang: 'en',
    search_scope: SCOPE,
    adaptor: 'Local Search Engine',
    tab: 'Everything',
  });
  return `${CATALOG_BASE_URL}?${params.toString()}`;
}

function findFullTextUrl(doc: PrimoDoc): string | null {
  const links = doc.delivery?.link ?? [];
  const fullText = links.find((link) => link.linkType === 'linktorsrc');
  return fullText ? fullText.linkURL : null;
}

export function mapDoc(doc: PrimoDoc): MappedResult {
  const recordId = first(doc.pnx.control?.recordid) ?? '';
  const display = doc.pnx.display ?? {};
  const addata = doc.pnx.addata ?? {};
  const authors = addata.au ?? (display.creator ?? []).map(stripPrimoMarkup);

  return {
    recordId,
    title: first(display.title) ?? 'Untitled',
    authors,
    type: first(display.type),
    date: first(display.creationdate),
    publisher: first(display.publisher),
    isbn: addata.isbn ?? [],
    issn: addata.issn ?? [],
    doi: first(addata.doi),
    description: first(display.description),
    contents: first(display.contents),
    availability: doc.delivery?.displayedAvailability ?? null,
    fullTextUrl: findFullTextUrl(doc),
    catalogUrl: recordId ? buildCatalogUrl(recordId) : '',
  };
}

export function mapSearchResponse(response: PrimoSearchResponse): SearchOneSearchResult {
  return {
    totalResults: response.info?.total ?? 0,
    results: (response.docs ?? []).map(mapDoc),
  };
}
