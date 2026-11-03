/**
 * Shared signal for "the library session is gone". A tool that hits this returns
 * a `login_required` result instead of a thrown error or a silently empty one.
 */

export const LOGIN_REQUIRED_MESSAGE =
  'Your Northeastern library session is missing or expired. Run `neu-onesearch-login` (or `node dist/login.js`) to sign in again.';

export class LoginRequiredError extends Error {
  readonly status = 'login_required' as const;
  constructor(message: string = LOGIN_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'LoginRequiredError';
  }
}

/** Hosts that mean "you were bounced to sign in" if a request lands there. */
const SSO_HOST_PATTERNS = [
  /(^|\.)neuidmsso\.neu\.edu$/i,
  /(^|\.)idp\.neu\.edu$/i,
  /(^|\.)shibboleth/i,
  /(^|\.)login\.ezproxy\.neu\.edu$/i,
  /(^|\.)duosecurity\.com$/i,
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when a response means the session was rejected: an HTTP 401/403, or a
 * request that (after following redirects) ended at a sign-in host. `fetch`
 * follows redirects by default, so the final `response.url` is where we landed.
 */
export function isLoginRedirect(response: Pick<Response, 'status' | 'url' | 'redirected'>): boolean {
  if (response.status === 401 || response.status === 403) return true;
  const host = hostOf(response.url ?? '');
  if (!host) return false;
  if (!response.redirected) return false;
  return SSO_HOST_PATTERNS.some((pattern) => pattern.test(host));
}
