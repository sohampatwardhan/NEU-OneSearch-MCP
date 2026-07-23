import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSession } from '../src/session.js';

let tempDir: string | undefined;

function writeFixture(content: string): string {
  tempDir = mkdtempSync(join(tmpdir(), 'onesearch-session-test-'));
  const path = join(tempDir, 'session.json');
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('loadSession', () => {
  it('returns null when the file does not exist', () => {
    expect(loadSession('/nonexistent/path/session.json')).toBeNull();
  });

  it('returns null when the file contains invalid JSON', () => {
    const path = writeFixture('not valid json {{{');
    expect(loadSession(path)).toBeNull();
  });

  it('returns null when the file has no cookies array', () => {
    const path = writeFixture(JSON.stringify({ origins: [] }));
    expect(loadSession(path)).toBeNull();
  });

  it('returns null when the cookies array is empty', () => {
    const path = writeFixture(JSON.stringify({ cookies: [] }));
    expect(loadSession(path)).toBeNull();
  });

  it('formats a single cookie as a Cookie header value', () => {
    const path = writeFixture(
      JSON.stringify({ cookies: [{ name: 'JSESSIONID', value: 'abc123' }] })
    );
    expect(loadSession(path)).toBe('JSESSIONID=abc123');
  });

  it('formats multiple cookies joined with "; "', () => {
    const path = writeFixture(
      JSON.stringify({
        cookies: [
          { name: 'JSESSIONID', value: 'abc123' },
          { name: 'urm_st', value: '456' },
        ],
      })
    );
    expect(loadSession(path)).toBe('JSESSIONID=abc123; urm_st=456');
  });
});
