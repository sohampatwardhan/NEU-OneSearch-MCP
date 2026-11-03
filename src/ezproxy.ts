/**
 * EZproxy URL helpers. The login CLI navigates to a proxied article so EZproxy
 * sets its session cookie after NU IT sign-in. Trimmed from PR #2 to what the
 * auth flow needs; full-text fetching is a separate spec.
 */

/** Canonical NEU library prefix. Primo `linktorsrc` links and the library bookmarklet use this host. */
export const EZPROXY_LOGIN_ORIGIN = 'https://link.ezproxy.neu.edu';

/**
 * Open-access PLOS ONE article. Login only navigates here so EZproxy will set a
 * session cookie after NU IT sign-in. The article itself is not special.
 */
export const EZPROXY_PROBE_DOI = '10.1371/journal.pone.0212767';

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeDoi(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  value = value.replace(/^doi:\s*/i, '');

  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'doi.org' && host !== 'dx.doi.org') return null;
    value = safeDecode(url.pathname.replace(/^\//, ''));
  }

  value = value.trim();
  if (!/^10\.\d{4,9}\/\S+$/i.test(value)) return null;
  if (/[\s<>]/.test(value)) return null;
  return value;
}

export function doiToHttpsUrl(doi: string): string | null {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;
  const path = normalized.split('/').map(encodeURIComponent).join('/');
  return `https://doi.org/${path}`;
}

/** Route a DOI through NEU's EZproxy login prefix. */
export function buildEzproxyDoiUrl(doi: string): string | null {
  const doiUrl = doiToHttpsUrl(doi);
  if (!doiUrl) return null;
  return `${EZPROXY_LOGIN_ORIGIN}/login?url=${encodeURIComponent(doiUrl)}`;
}
