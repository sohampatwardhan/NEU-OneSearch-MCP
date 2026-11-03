import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the persistent browser profile and the cached cookies live. Owner-only.
 *
 * `NEU_ONESEARCH_CACHE_DIR` overrides the location. It is a path only: this
 * project never accepts a password or a raw cookie value through the
 * environment. Default follows the XDG cache convention.
 */
export function resolveCacheDir(): string {
  const override = process.env.NEU_ONESEARCH_CACHE_DIR?.trim();
  return override ? override : join(homedir(), '.cache', 'neu-onesearch-mcp');
}

/** Dedicated Playwright Chrome profile directory (keeps the IdP + Duo session). */
export function profileDir(): string {
  return join(resolveCacheDir(), 'profile');
}

/** Small JSON snapshot of the captured cookies plus a capture timestamp. */
export function sessionCachePath(): string {
  return join(resolveCacheDir(), 'session.json');
}

/** Create the cache directory with owner-only (0700) permissions. Idempotent. */
export function ensureCacheDir(): void {
  mkdirSync(resolveCacheDir(), { recursive: true, mode: 0o700 });
}

export interface RemoveResult {
  cacheRemoved: boolean;
  profileRemoved: boolean;
}

/**
 * Delete the cached session file and the persistent profile directory. Safe to
 * call when either or both are already absent (reports what was actually there).
 */
export function removeSession(): RemoveResult {
  const cachePath = sessionCachePath();
  const profile = profileDir();

  const cacheRemoved = existsSync(cachePath);
  const profileRemoved = existsSync(profile);

  rmSync(cachePath, { force: true });
  rmSync(profile, { recursive: true, force: true });

  return { cacheRemoved, profileRemoved };
}
