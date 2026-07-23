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
    expect(result.doiUrl).toBe('https://doi.org/10.1007/978-981-15-1967-3');
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
    expect(result.doiUrl).toBeNull();
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

  it('threads the campus scope through to the catalog permalink', () => {
    const doc = fixture.docs[0];
    const defaultResult = mapDoc(doc);
    expect(defaultResult.catalogUrl).toContain('search_scope=CDI_plus_all_local');
    expect(defaultResult.catalogUrl).toContain('tab=Everything');

    const oaklandResult = mapDoc(doc, 'oakland');
    expect(oaklandResult.catalogUrl).toContain('search_scope=Mills_and_CI');
    expect(oaklandResult.catalogUrl).toContain('tab=Oakland');
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

  it('passes the campus scope through to every mapped result', () => {
    const result = mapSearchResponse(fixture, 'boston');
    expect(result.results[0].catalogUrl).toContain('search_scope=MyInst_and_CI');
    expect(result.results[0].catalogUrl).toContain('tab=Boston');
    expect(result.results[1].catalogUrl).toContain('search_scope=MyInst_and_CI');
    expect(result.results[1].catalogUrl).toContain('tab=Boston');
  });
});
