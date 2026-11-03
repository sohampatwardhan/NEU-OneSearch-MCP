import { describe, it, expect } from 'vitest';
import { isLoginRedirect, LoginRequiredError, LOGIN_REQUIRED_MESSAGE } from '../src/auth.js';

function resp(status: number, url: string, redirected: boolean) {
  return { status, url, redirected } as Pick<Response, 'status' | 'url' | 'redirected'>;
}

describe('isLoginRedirect', () => {
  it('is true for 401 and 403', () => {
    expect(isLoginRedirect(resp(401, 'https://onesearch.library.northeastern.edu/x', false))).toBe(true);
    expect(isLoginRedirect(resp(403, 'https://onesearch.library.northeastern.edu/x', false))).toBe(true);
  });

  it('is true when a request was redirected to an SSO host', () => {
    expect(isLoginRedirect(resp(200, 'https://neuidmsso.neu.edu/idp/profile/SAML2', true))).toBe(true);
    expect(isLoginRedirect(resp(200, 'https://login.ezproxy.neu.edu/login', true))).toBe(true);
  });

  it('is false for a normal 200 at the expected host', () => {
    expect(isLoginRedirect(resp(200, 'https://onesearch.library.northeastern.edu/primaws/x', false))).toBe(false);
  });

  it('is false when redirected but not to an SSO host', () => {
    expect(isLoginRedirect(resp(200, 'https://onesearch.library.northeastern.edu/other', true))).toBe(false);
  });
});

describe('LoginRequiredError', () => {
  it('carries the login_required status and a helpful message', () => {
    const err = new LoginRequiredError();
    expect(err.status).toBe('login_required');
    expect(err.message).toBe(LOGIN_REQUIRED_MESSAGE);
    expect(err.message).toContain('login');
  });
});
