import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveCacheDir,
  profileDir,
  sessionCachePath,
  ensureCacheDir,
  removeSession,
} from '../src/cache.js';

let tempDir: string | undefined;
const ORIG = process.env.NEU_ONESEARCH_CACHE_DIR;

function useTempCacheDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'onesearch-cache-test-'));
  const dir = join(tempDir, 'neu-onesearch-mcp');
  process.env.NEU_ONESEARCH_CACHE_DIR = dir;
  return dir;
}

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEU_ONESEARCH_CACHE_DIR;
  else process.env.NEU_ONESEARCH_CACHE_DIR = ORIG;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('resolveCacheDir', () => {
  it('honors the NEU_ONESEARCH_CACHE_DIR override', () => {
    const dir = useTempCacheDir();
    expect(resolveCacheDir()).toBe(dir);
  });

  it('falls back to ~/.cache/neu-onesearch-mcp when no override is set', () => {
    delete process.env.NEU_ONESEARCH_CACHE_DIR;
    expect(resolveCacheDir()).toBe(join(homedir(), '.cache', 'neu-onesearch-mcp'));
  });

  it('places the profile dir and session file inside the cache dir', () => {
    const dir = useTempCacheDir();
    expect(profileDir()).toBe(join(dir, 'profile'));
    expect(sessionCachePath()).toBe(join(dir, 'session.json'));
  });
});

describe('ensureCacheDir', () => {
  it('creates the cache dir with owner-only (0700) permissions', () => {
    const dir = useTempCacheDir();
    ensureCacheDir();
    expect(existsSync(dir)).toBe(true);
    // Low 3 octal digits only; skip on platforms without POSIX modes.
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('is idempotent when the dir already exists', () => {
    useTempCacheDir();
    ensureCacheDir();
    expect(() => ensureCacheDir()).not.toThrow();
  });
});

describe('removeSession', () => {
  it('deletes the session file and the profile dir', () => {
    const dir = useTempCacheDir();
    ensureCacheDir();
    writeFileSync(sessionCachePath(), '{}', { mode: 0o600 });
    mkdirSync(profileDir(), { recursive: true });
    writeFileSync(join(profileDir(), 'Preferences'), 'x');

    const result = removeSession();
    expect(result.cacheRemoved).toBe(true);
    expect(result.profileRemoved).toBe(true);
    expect(existsSync(sessionCachePath())).toBe(false);
    expect(existsSync(profileDir())).toBe(false);
  });

  it('is idempotent and reports nothing removed when neither exists', () => {
    useTempCacheDir();
    const result = removeSession();
    expect(result.cacheRemoved).toBe(false);
    expect(result.profileRemoved).toBe(false);
  });

  it('removes only what exists when the profile is absent', () => {
    useTempCacheDir();
    ensureCacheDir();
    writeFileSync(sessionCachePath(), '{}', { mode: 0o600 });
    const result = removeSession();
    expect(result.cacheRemoved).toBe(true);
    expect(result.profileRemoved).toBe(false);
  });
});
