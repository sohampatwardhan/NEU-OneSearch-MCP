# NEU OneSearch MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, stdio-based MCP server that lets Claude search Northeastern University's Scholar OneSearch (Primo VE) for academic references, using NEU's unauthenticated internal search API.

**Architecture:** A small TypeScript package with three focused modules — `primoClient.ts` (builds requests to Primo's internal `primaws/rest/pub/pnxs` JSON endpoint), `mapper.ts` (flattens raw Primo JSON into a clean result shape), and `index.ts` (registers two MCP tools, `search_onesearch` and `get_record`, wiring the two together) — served over stdio via `@modelcontextprotocol/sdk`.

**Tech Stack:** TypeScript (Node.js >=18, ESM), `@modelcontextprotocol/sdk` 1.29.x, `zod` for input schemas, `vitest` for tests, `tsx` for local dev running.

## Global Constraints

- No API key, no NU SSO/login — the server calls NEU's internal, unauthenticated `primaws/rest/pub/pnxs` endpoint directly.
- Hardcoded NEU-specific constants: `vid=01NEU_INST:NUL`, `inst=01NEU_INST`, `scope=MyInst_and_CI`, `tab=Everything`.
- **Only one facet filter may be applied per search** (`resourceType`, a date range, or `peerReviewedOnly` — never more than one at once). This was verified empirically against the live endpoint: combining more than one `qInclude` facet clause silently drops all but the first, so the client must reject combinations rather than silently return wrong results (see Task 3).
- Response parsing must be defensive (missing fields default to `null`/`[]`, never throw on absent optional fields) since this is an undocumented, unofficial endpoint that could change shape without notice.
- Claude must never see raw Primo PNX JSON — `mapper.ts` always flattens to the clean `MappedResult` shape before a tool returns.
- Local stdio server only — no HTTP server, no remote deployment, no auth for the server process itself.

---

## Task 1: Project scaffolding and shared types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/types.ts`

**Interfaces:**
- Produces: `SearchOneSearchParams`, `MappedResult`, `SearchOneSearchResult`, `PrimoLink`, `PrimoDelivery`, `PrimoDisplay`, `PrimoControl`, `PrimoAddata`, `PrimoDoc`, `PrimoSearchResponse` (all exported from `src/types.ts`) — used by every later task.

- [x] **Step 1: Create `package.json`**

```json
{
  "name": "neu-onesearch-mcp",
  "version": "0.1.0",
  "description": "MCP server for Northeastern University Scholar OneSearch",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "neu-onesearch-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.16.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.14.0"
  }
}
```

- [x] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [x] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [x] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
```

- [x] **Step 5: Create `src/types.ts`**

```typescript
export interface SearchOneSearchParams {
  query: string;
  limit?: number;
  resourceType?:
    | 'articles'
    | 'journals'
    | 'books'
    | 'newspaper_articles'
    | 'reviews'
    | 'book_chapters'
    | 'dissertations';
  dateFrom?: number;
  dateTo?: number;
  peerReviewedOnly?: boolean;
  sort?: 'rank' | 'date' | 'title' | 'author';
}

export interface MappedResult {
  recordId: string;
  title: string;
  authors: string[];
  type: string | null;
  date: string | null;
  publisher: string | null;
  isbn: string[];
  issn: string[];
  doi: string | null;
  description: string | null;
  contents: string | null;
  availability: string | null;
  fullTextUrl: string | null;
  catalogUrl: string;
}

export interface SearchOneSearchResult {
  totalResults: number;
  results: MappedResult[];
}

export interface PrimoLink {
  linkType: string;
  linkURL: string;
  displayLabel?: string;
}

export interface PrimoDelivery {
  displayedAvailability?: string | null;
  link?: PrimoLink[] | null;
}

export interface PrimoDisplay {
  title?: string[];
  creator?: string[];
  type?: string[];
  creationdate?: string[];
  publisher?: string[];
  description?: string[];
  contents?: string[];
}

export interface PrimoControl {
  recordid?: string[];
}

export interface PrimoAddata {
  au?: string[];
  isbn?: string[];
  issn?: string[];
  doi?: string[];
}

export interface PrimoDoc {
  pnx: {
    display?: PrimoDisplay;
    control?: PrimoControl;
    addata?: PrimoAddata;
  };
  delivery?: PrimoDelivery;
}

export interface PrimoSearchResponse {
  info: { total: number };
  docs: PrimoDoc[];
}
```

- [x] **Step 6: Install dependencies and verify the build**

Run: `npm install`
Expected: installs without error.

Run: `npm run build`
Expected: compiles without error (only `dist/types.js` and `dist/types.d.ts`-less output since `declaration: false`; `dist/types.js` should exist).

- [x] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/types.ts package-lock.json
git commit -m "chore: scaffold TypeScript MCP server project with shared types"
```

---

## Task 2: Primo JSON fixture and result mapper

**Files:**
- Create: `test/fixtures/primo-search-response.json`
- Create: `test/mapper.test.ts`
- Create: `src/mapper.ts`

**Interfaces:**
- Consumes: `PrimoDoc`, `PrimoSearchResponse`, `MappedResult`, `SearchOneSearchResult` from `src/types.ts` (Task 1).
- Produces: `mapDoc(doc: PrimoDoc): MappedResult` and `mapSearchResponse(response: PrimoSearchResponse): SearchOneSearchResult`, both exported from `src/mapper.ts` — used by `src/index.ts` (Task 4).

- [x] **Step 1: Create the fixture file `test/fixtures/primo-search-response.json`**

This is real data captured from NEU's live OneSearch endpoint (trimmed to the fields the mapper reads), covering two contrasting cases: a book with full delivery/full-text info, and a journal title with several optional fields absent.

```json
{
  "info": { "total": 6379075 },
  "docs": [
    {
      "pnx": {
        "display": {
          "title": ["Machine learning"],
          "creator": ["Zhou, Zhi-Hua (Computer scientist), author.$$QZhou, Zhi-Hua"],
          "type": ["book"],
          "creationdate": ["2021"],
          "publisher": ["Singapore : Springer"],
          "description": [
            "Machine Learning, a vital and core area of artificial intelligence (AI), is propelling the AI field ever further and making it one of the most compelling areas of computer science research."
          ],
          "contents": [
            "1 Introduction -- 2 Model Selection and Evaluation -- 3 Linear Models -- 4 Decision Trees -- 5 Neural Networks -- 6 Support Vector Machine."
          ]
        },
        "control": {
          "recordid": ["alma9952077153901401"]
        },
        "addata": {
          "au": ["Zhou, Zhi-Hua"],
          "isbn": ["9789811519673", "9811519676", "9811519668", "9789811519666"],
          "doi": ["10.1007/978-981-15-1967-3"]
        }
      },
      "delivery": {
        "displayedAvailability": "Not available",
        "link": [
          {
            "linkType": "thumbnail",
            "linkURL": "https://proxy-na.hosted.exlibrisgroup.com/exl_rewrite/books.google.com/books?bibkeys=ISBN:9811519676,OCLC:,LCCN:&jscmd=viewapi&callback=updateGBSCover",
            "displayLabel": "thumbnail"
          },
          {
            "linkType": "linktorsrc",
            "linkURL": "https://link.ezproxy.neu.edu/login?url=https://link.springer.com/10.1007/978-981-15-1967-3",
            "displayLabel": "View book online"
          }
        ]
      }
    },
    {
      "pnx": {
        "display": {
          "title": ["Machine learning."],
          "type": ["journal"],
          "creationdate": ["1986"],
          "publisher": ["Boston : Kluwer Academic Publishers"]
        },
        "control": {
          "recordid": ["alma9946638590001401"]
        },
        "addata": {
          "issn": ["1573-0565", "0885-6125"]
        }
      },
      "delivery": {
        "displayedAvailability": "Not available",
        "link": [
          {
            "linkType": "thumbnail",
            "linkURL": "https://proxy-na.hosted.exlibrisgroup.com/exl_rewrite/books.google.com/books?bibkeys=ISBN:,OCLC:,LCCN:2008233030&jscmd=viewapi&callback=updateGBSCover",
            "displayLabel": "thumbnail"
          }
        ]
      }
    }
  ]
}
```

- [x] **Step 2: Write the failing tests in `test/mapper.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mapDoc, mapSearchResponse } from '../src/mapper.js';
import type { PrimoDoc, PrimoSearchResponse } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture: PrimoSearchResponse = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/primo-search-response.json'), 'utf-8')
);

describe('mapDoc', () => {
  it('maps a book record with full delivery info', () => {
    const result = mapDoc(fixture.docs[0]);
    expect(result.recordId).toBe('alma9952077153901401');
    expect(result.title).toBe('Machine learning');
    expect(result.authors).toEqual(['Zhou, Zhi-Hua']);
    expect(result.type).toBe('book');
    expect(result.date).toBe('2021');
    expect(result.publisher).toBe('Singapore : Springer');
    expect(result.isbn).toEqual(['9789811519673', '9811519676', '9811519668', '9789811519666']);
    expect(result.issn).toEqual([]);
    expect(result.doi).toBe('10.1007/978-981-15-1967-3');
    expect(result.description).toContain('Machine Learning, a vital and core area');
    expect(result.contents).toContain('1 Introduction');
    expect(result.availability).toBe('Not available');
    expect(result.fullTextUrl).toBe(
      'https://link.ezproxy.neu.edu/login?url=https://link.springer.com/10.1007/978-981-15-1967-3'
    );
    expect(result.catalogUrl).toContain('docid=alma9952077153901401');
  });

  it('handles a record missing authors, isbn, doi, description, contents, and full-text link', () => {
    const result = mapDoc(fixture.docs[1]);
    expect(result.recordId).toBe('alma9946638590001401');
    expect(result.title).toBe('Machine learning.');
    expect(result.authors).toEqual([]);
    expect(result.isbn).toEqual([]);
    expect(result.issn).toEqual(['1573-0565', '0885-6125']);
    expect(result.doi).toBeNull();
    expect(result.description).toBeNull();
    expect(result.contents).toBeNull();
    expect(result.fullTextUrl).toBeNull();
  });

  it('strips Primo internal $$ markup from creator when addata.au is absent', () => {
    const doc: PrimoDoc = {
      pnx: {
        display: { title: ['Test'], creator: ['Smith, Jane$$QSmith, Jane'] },
        control: { recordid: ['alma123'] },
        addata: {},
      },
    };
    const result = mapDoc(doc);
    expect(result.authors).toEqual(['Smith, Jane']);
  });
});

describe('mapSearchResponse', () => {
  it('maps total count and all docs', () => {
    const result = mapSearchResponse(fixture);
    expect(result.totalResults).toBe(6379075);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].recordId).toBe('alma9952077153901401');
    expect(result.results[1].recordId).toBe('alma9946638590001401');
  });

  it('returns an empty results array for a response with no docs', () => {
    const result = mapSearchResponse({ info: { total: 0 }, docs: [] });
    expect(result.totalResults).toBe(0);
    expect(result.results).toEqual([]);
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/mapper.test.ts`
Expected: FAIL — `Cannot find module '../src/mapper.js'` (module doesn't exist yet).

- [x] **Step 4: Create `src/mapper.ts`**

```typescript
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
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/mapper.test.ts`
Expected: PASS (6 tests).

- [x] **Step 6: Commit**

```bash
git add test/fixtures/primo-search-response.json test/mapper.test.ts src/mapper.ts
git commit -m "feat: add Primo result mapper with fixture-backed tests"
```

---

## Task 3: Primo HTTP client

**Files:**
- Create: `src/primoClient.ts`
- Create: `test/primoClient.test.ts`

**Interfaces:**
- Consumes: `SearchOneSearchParams`, `PrimoDoc`, `PrimoSearchResponse` from `src/types.ts` (Task 1).
- Produces: `buildFacetClause(params: SearchOneSearchParams): string`, `buildSearchParams(params: SearchOneSearchParams): URLSearchParams`, `searchOneSearch(params: SearchOneSearchParams): Promise<PrimoSearchResponse>`, `getRecord(recordId: string): Promise<PrimoDoc | null>`, all exported from `src/primoClient.ts` — used by `src/index.ts` (Task 4).

- [x] **Step 1: Write the failing tests in `test/primoClient.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFacetClause, buildSearchParams, searchOneSearch, getRecord } from '../src/primoClient.js';

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
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/primoClient.test.ts`
Expected: FAIL — `Cannot find module '../src/primoClient.js'`.

- [x] **Step 3: Create `src/primoClient.ts`**

```typescript
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
  return response.json() as Promise<PrimoSearchResponse>;
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
  return response.docs[0] ?? null;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/primoClient.test.ts`
Expected: PASS (11 tests).

- [x] **Step 5: Commit**

```bash
git add src/primoClient.ts test/primoClient.test.ts
git commit -m "feat: add Primo HTTP client with facet-conflict validation"
```

---

## Task 4: MCP server wiring

**Files:**
- Create: `src/index.ts`
- Create: `test/index.test.ts`

**Interfaces:**
- Consumes: `searchOneSearch`, `getRecord` from `src/primoClient.ts` (Task 3); `mapSearchResponse`, `mapDoc` from `src/mapper.ts` (Task 2).
- Produces: `createServer(): McpServer`, exported from `src/index.ts` — the MCP server factory, used directly by tests and by the `main()` entrypoint in the same file.

- [x] **Step 1: Write the failing tests in `test/index.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/index.js';

async function connectedClient(server: ReturnType<typeof createServer>) {
  const client = new Client({ name: 'test client', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);
  return client;
}

describe('MCP server tools', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('search_onesearch returns mapped results as JSON text', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        info: { total: 1 },
        docs: [
          {
            pnx: {
              display: { title: ['Test Title'], type: ['book'] },
              control: { recordid: ['alma1'] },
              addata: {},
            },
          },
        ],
      }),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'search_onesearch', arguments: { query: 'test' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.totalResults).toBe(1);
    expect(parsed.results[0].title).toBe('Test Title');
  });

  it('search_onesearch surfaces a facet-conflict error as a tool error', async () => {
    const client = await connectedClient(createServer());
    const result = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'search_onesearch',
          arguments: { query: 'test', resourceType: 'books', peerReviewedOnly: true },
        },
      },
      CallToolResultSchema
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('only supports one filter');
  });

  it('get_record returns an error message for unsupported record ids', async () => {
    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'get_record', arguments: { recordId: 'cdi_foo' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('only supports Northeastern catalog records');
  });

  it('get_record returns "no record found" for a valid but missing id', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'get_record', arguments: { recordId: 'alma999' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('No record found');
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [x] **Step 3: Create `src/index.ts`**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { searchOneSearch, getRecord } from './primoClient.js';
import { mapSearchResponse, mapDoc } from './mapper.js';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'neu-onesearch-mcp', version: '0.1.0' });

  server.registerTool(
    'search_onesearch',
    {
      description:
        'Search Northeastern University Scholar OneSearch for academic references and library resources.',
      inputSchema: {
        query: z.string().describe('Free-text search query'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 10, max 50)'),
        resourceType: z
          .enum(['articles', 'journals', 'books', 'newspaper_articles', 'reviews', 'book_chapters', 'dissertations'])
          .optional()
          .describe('Filter to one resource type'),
        dateFrom: z.number().int().optional().describe('Earliest publication year'),
        dateTo: z.number().int().optional().describe('Latest publication year'),
        peerReviewedOnly: z.boolean().optional().describe('Only return peer-reviewed results'),
        sort: z.enum(['rank', 'date', 'title', 'author']).optional().describe('Sort order (default rank)'),
      },
    },
    async (params) => {
      try {
        const raw = await searchOneSearch(params);
        const mapped = mapSearchResponse(raw);
        return { content: [{ type: 'text' as const, text: JSON.stringify(mapped, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `OneSearch search failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_record',
    {
      description:
        'Fetch full detail for a single OneSearch catalog record (abstract, table of contents, availability, full-text link).',
      inputSchema: {
        recordId: z.string().describe('Record id from a prior search_onesearch result (must start with "alma")'),
      },
    },
    async ({ recordId }) => {
      try {
        const doc = await getRecord(recordId);
        if (!doc) {
          return { content: [{ type: 'text' as const, text: `No record found for id: ${recordId}` }] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(mapDoc(doc), null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `get_record failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/index.test.ts`
Expected: PASS (4 tests).

- [x] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all tests across all files).

- [x] **Step 6: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: wire search_onesearch and get_record MCP tools"
```

---

## Task 5: Manual smoke test, README, and Claude config wiring

**Files:**
- Create: `scripts/smoke-test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: `searchOneSearch`, `getRecord` from `dist/primoClient.js` (the built output of Task 3) — this script runs against compiled JS, not source, since it's a plain Node script with no TypeScript loader.

- [x] **Step 1: Create `scripts/smoke-test.mjs`**

```javascript
import { searchOneSearch, getRecord } from '../dist/primoClient.js';

async function main() {
  console.log('Searching OneSearch for "machine learning"...');
  const searchResult = await searchOneSearch({ query: 'machine learning', limit: 3 });
  console.log(`Total results: ${searchResult.info.total}`);
  const firstDoc = searchResult.docs[0];
  console.log(`First doc title: ${firstDoc?.pnx.display?.title?.[0]}`);

  const recordId = firstDoc?.pnx.control?.recordid?.[0];
  if (recordId && recordId.startsWith('alma')) {
    console.log(`Fetching full record for ${recordId}...`);
    const record = await getRecord(recordId);
    console.log(`Record availability: ${record?.delivery?.displayedAvailability}`);
  } else {
    console.log('First result is not an NEU catalog record; skipping get_record check.');
  }

  console.log('Smoke test passed.');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exitCode = 1;
});
```

- [x] **Step 2: Build and run the smoke test manually**

Run: `npm run build && node scripts/smoke-test.mjs`
Expected: prints a non-zero total result count, a real book/article title, and (usually) an availability string — confirming the live endpoint still behaves as this plan assumes. This step depends on an external, unofficial service and is not part of `npm test` / CI.

- [x] **Step 3: Update `README.md`**

```markdown
# NEU-OneSearch-MCP

An MCP server for Northeastern University's Scholar OneSearch
(https://onesearch.library.northeastern.edu). Lets Claude search NEU's
library catalog and article databases for academic references.

Search-only: no login, no personal account features. See
`docs/superpowers/specs/2026-07-22-onesearch-mcp-design.md` for the full
design and research behind this.

## Setup

```bash
npm install
npm run build
```

## Add to Claude Desktop / Claude Code

Add to your MCP config (e.g. `claude_desktop_config.json`), using the
absolute path to this repo:

```json
{
  "mcpServers": {
    "neu-onesearch": {
      "command": "node",
      "args": ["/absolute/path/to/NEU-OneSearch-MCP/dist/index.js"]
    }
  }
}
```

## Tools

- `search_onesearch(query, limit?, resourceType?, dateFrom?, dateTo?, peerReviewedOnly?, sort?)` —
  free-text search. Only one of `resourceType`, `dateFrom`/`dateTo`, or
  `peerReviewedOnly` may be set per call — NEU's search API only honors one
  filter at a time.
- `get_record(recordId)` — fetch full detail (abstract, table of contents,
  availability, full-text link) for one result from a prior search. Only
  supports NEU catalog records (`recordId` starting with `alma`).

## Development

```bash
npm run dev    # run the server directly via tsx, for manual stdio testing
npm test       # run the automated test suite
```

## Manual live smoke test

Hits the real OneSearch endpoint — not part of `npm test`, run manually to
confirm the (unofficial) endpoint still behaves as expected:

```bash
npm run build && node scripts/smoke-test.mjs
```
```

- [x] **Step 4: Commit**

```bash
git add scripts/smoke-test.mjs README.md
git commit -m "docs: add README setup instructions and manual smoke test script"
```

---

## Task 6: Campus scope selection

See the design spec's "Addendum (2026-07-22): campus scope selection" section
for the full research/rationale. Summary: NEU's Primo VE config exposes four
campus-scoped views as `tab`/`scope` pairs. The server currently hardcodes
`tab=Everything` + `scope=MyInst_and_CI` (Task 3) — which is actually the
*Boston* scope value mislabeled as "Everything", not genuine all-campus
results. This task adds a `campus` param to `search_onesearch` and fixes the
default to true all-campus scope.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/primoClient.ts`
- Modify: `src/index.ts`
- Modify: `test/primoClient.test.ts`
- Modify: `test/index.test.ts`

**Interfaces:**
- Consumes: existing `SearchOneSearchParams`, `buildSearchParams`, `getRecord`, `createServer`.
- Produces: `SearchOneSearchParams.campus?: 'all' | 'boston' | 'oakland' | 'online'` — a new optional field later tasks (none currently planned) could depend on.

- [ ] **Step 1: Add the failing/updated tests in `test/primoClient.test.ts`**

Add this new `describe` block (place it after the existing `describe('buildSearchParams', ...)` block):

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/primoClient.test.ts`
Expected: FAIL — `tab`/`scope` assertions fail against the current hardcoded `SCOPE='MyInst_and_CI'`/`TAB='Everything'` values (e.g. the Boston-scope test expects `tab=Boston` but gets `Everything`).

- [ ] **Step 3: Update `src/types.ts`**

Add `campus` to `SearchOneSearchParams`:

```typescript
export interface SearchOneSearchParams {
  query: string;
  limit?: number;
  resourceType?:
    | 'articles'
    | 'journals'
    | 'books'
    | 'newspaper_articles'
    | 'reviews'
    | 'book_chapters'
    | 'dissertations';
  dateFrom?: number;
  dateTo?: number;
  peerReviewedOnly?: boolean;
  sort?: 'rank' | 'date' | 'title' | 'author';
  campus?: 'all' | 'boston' | 'oakland' | 'online';
}
```

(This is the existing interface with only the `campus` field added at the end — every other field is unchanged.)

- [ ] **Step 4: Update `src/primoClient.ts`**

Replace the `SCOPE`/`TAB` constants and their usages. The full updated file:

```typescript
import type { PrimoDoc, PrimoSearchResponse, SearchOneSearchParams } from './types.js';

const BASE_URL = 'https://onesearch.library.northeastern.edu/primaws/rest/pub/pnxs';
const INST = '01NEU_INST';
const VID = '01NEU_INST:NUL';

const CAMPUS_SCOPES: Record<'all' | 'boston' | 'oakland' | 'online', { tab: string; scope: string }> = {
  all: { tab: 'Everything', scope: 'CDI_plus_all_local' },
  boston: { tab: 'Boston', scope: 'MyInst_and_CI' },
  oakland: { tab: 'Oakland', scope: 'Mills_and_CI' },
  online: { tab: 'Online', scope: 'CDI_and_EResources' },
};

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

export async function getRecord(recordId: string): Promise<PrimoDoc | null> {
  if (!recordId.startsWith('alma')) {
    throw new Error(
      `get_record only supports Northeastern catalog records (recordId starting with "alma"), received: ${recordId}`
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/primoClient.test.ts`
Expected: PASS (20 tests: the pre-existing 15 plus 5 new campus-scope tests).

- [ ] **Step 6: Add a test in `test/index.test.ts` for the new `campus` param**

Add this test (place it after the existing `'search_onesearch returns mapped results as JSON text'` test):

```typescript
  it('search_onesearch accepts a campus param and passes it through to the fetch call', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    const client = await connectedClient(createServer());
    const result = await client.request(
      { method: 'tools/call', params: { name: 'search_onesearch', arguments: { query: 'test', campus: 'oakland' } } },
      CallToolResultSchema
    );

    expect(result.isError).toBeFalsy();
    const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain('tab=Oakland');
    expect(calledUrl).toContain('scope=Mills_and_CI');
  });
```

- [ ] **Step 7: Update `src/index.ts`'s zod schema**

In the `search_onesearch` tool's `inputSchema`, add a `campus` field (place it after `sort`):

```typescript
        sort: z.enum(['rank', 'date', 'title', 'author']).optional().describe('Sort order (default rank)'),
        campus: z
          .enum(['all', 'boston', 'oakland', 'online'])
          .optional()
          .describe('Restrict to one NEU campus/scope (default: all campuses)'),
```

(This is the existing `sort` line followed by the new `campus` field — every other field in the schema is unchanged.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run test/index.test.ts`
Expected: PASS (5 tests: the pre-existing 4 plus the new campus-param test).

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: PASS (29 tests total across all files: 20 primoClient + 5 mapper + 5 index... wait, recount: 5 mapper + 20 primoClient + 5 index = 30 total). Note the exact final count may differ slightly by 1-2 from this estimate depending on final test authoring — what matters is 100% pass, zero failures.

- [ ] **Step 10: Update `README.md`**

In the "Tools" section, update the `search_onesearch` line to mention the new param:

```markdown
- `search_onesearch(query, limit?, resourceType?, dateFrom?, dateTo?, peerReviewedOnly?, sort?, campus?)` —
  free-text search. Only one of `resourceType`, `dateFrom`/`dateTo`, or
  `peerReviewedOnly` may be set per call — NEU's search API only honors one
  filter at a time. `campus` restricts to one NEU campus/scope (`all`
  (default), `boston`, `oakland`, or `online`) — `all` is genuine all-campus
  results (`CDI_plus_all_local`), not just Boston + central index.
```

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/primoClient.ts src/index.ts test/primoClient.test.ts test/index.test.ts README.md
git commit -m "feat: add campus scope selection and fix mislabeled default scope"
```
