import { describe, it, expect } from 'vitest';
import {
  EZPROXY_LOGIN_ORIGIN,
  EZPROXY_PROBE_DOI,
  normalizeDoi,
  doiToHttpsUrl,
  buildEzproxyDoiUrl,
} from '../src/ezproxy.js';

describe('normalizeDoi', () => {
  it('accepts a bare DOI', () => {
    expect(normalizeDoi('10.1038/s41586-020-2649-2')).toBe('10.1038/s41586-020-2649-2');
  });
  it('strips a doi: prefix and a doi.org URL', () => {
    expect(normalizeDoi('doi:10.1000/xyz')).toBe('10.1000/xyz');
    expect(normalizeDoi('https://doi.org/10.1000/xyz')).toBe('10.1000/xyz');
    expect(normalizeDoi('https://dx.doi.org/10.1000/xyz')).toBe('10.1000/xyz');
  });
  it('rejects empty, non-DOI, or non-doi.org URLs', () => {
    expect(normalizeDoi('')).toBeNull();
    expect(normalizeDoi('not a doi')).toBeNull();
    expect(normalizeDoi('https://evil.example/10.1/x')).toBeNull();
  });
});

describe('doiToHttpsUrl', () => {
  it('builds a doi.org URL with each path segment encoded', () => {
    expect(doiToHttpsUrl('10.1000/xyz')).toBe('https://doi.org/10.1000/xyz');
  });
  it('returns null for an invalid DOI', () => {
    expect(doiToHttpsUrl('nope')).toBeNull();
  });
});

describe('buildEzproxyDoiUrl', () => {
  it('routes a valid DOI through the library login prefix', () => {
    const url = buildEzproxyDoiUrl('10.1000/xyz');
    expect(url).toBe(`${EZPROXY_LOGIN_ORIGIN}/login?url=${encodeURIComponent('https://doi.org/10.1000/xyz')}`);
  });
  it('returns null for an invalid DOI', () => {
    expect(buildEzproxyDoiUrl('nope')).toBeNull();
  });
  it('has a valid probe DOI', () => {
    expect(buildEzproxyDoiUrl(EZPROXY_PROBE_DOI)).not.toBeNull();
  });
});
