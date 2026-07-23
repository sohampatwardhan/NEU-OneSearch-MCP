# NEU OneSearch MCP Server Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone NEU SAML login CLI and session-reuse plumbing so the existing `search_onesearch`/`get_record` tools transparently attach a signed-in session when one exists.

**Architecture:** A new `src/session.ts` module owns reading/parsing the session file into a `Cookie` header value. `src/primoClient.ts`'s existing `fetchPrimo` attaches that header when present — with no session file, behavior is unchanged. A new `src/login.ts` CLI script (run manually via `node dist/login.js`, never imported by the MCP server itself) drives a real Playwright browser through NEU's actual SSO login and writes the resulting session to disk.

**Tech Stack:** TypeScript (Node.js >=18, ESM), `playwright` (new dependency, ^1.61.1), `vitest` for tests.

## Global Constraints

- No password ever touches this codebase — the user completes the real NEU SSO login themselves, in a real browser window.
- With no session file present, every existing request must be byte-for-byte identical to today's fully anonymous behavior — this is strictly additive, never a breaking change to current search/get_record behavior.
- Session file lives outside the repo, at `~/.neu-onesearch-mcp/session.json`, permissions `0600` (owner read/write only).
- `login.ts` is intentionally standalone — not imported by `index.ts` or `primoClient.ts`'s module graph beyond the shared `SESSION_PATH` constant. The MCP server itself gains no new runtime dependency weight from Playwright; only running `node dist/login.js` does.
- **Staleness/expiry detection is explicitly out of scope for this plan** — the real signal that distinguishes an expired session from a valid one in a Primo response is unverified and requires a live spike with a real NEU login (tracked as a follow-up, not planned here). Do not add speculative expiry-detection logic.

---

## Task 1: Session file reader

**Files:**
- Create: `src/session.ts`
- Create: `test/session.test.ts`

**Interfaces:**
- Produces: `SESSION_PATH: string` (the resolved path `~/.neu-onesearch-mcp/session.json`) and `loadSession(path?: string): string | null`, both exported from `src/session.ts` — used by `src/primoClient.ts` (Task 2) and `src/login.ts` (Task 3).

- [x] **Step 1: Write the failing tests in `test/session.test.ts`**

```typescript
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
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/session.test.ts`
Expected: FAIL — `Cannot find module '../src/session.js'`.

- [x] **Step 3: Create `src/session.ts`**

```typescript
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION_PATH = join(homedir(), '.neu-onesearch-mcp', 'session.json');

interface StoredCookie {
  name: string;
  value: string;
}

interface StorageState {
  cookies?: StoredCookie[];
}

export function loadSession(path: string = SESSION_PATH): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  let parsed: StorageState;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed.cookies) || parsed.cookies.length === 0) {
    return null;
  }

  return parsed.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/session.test.ts`
Expected: PASS (6 tests).

- [x] **Step 5: Commit**

```bash
git add src/session.ts test/session.test.ts
git commit -m "feat: add session file reader for stored NEU login cookies"
```

---

## Task 2: Wire session cookies into primoClient requests

**Files:**
- Modify: `src/primoClient.ts`
- Modify: `test/primoClient.test.ts`

**Interfaces:**
- Consumes: `loadSession` from `src/session.ts` (Task 1).
- Produces: no new exports — `fetchPrimo` (private) now attaches a `Cookie` header when `loadSession()` returns a value; `searchOneSearch`/`getRecord`'s public signatures are unchanged.

- [x] **Step 1: Write the failing tests in `test/primoClient.test.ts`**

Add this import at the top of the file (alongside the existing imports):

```typescript
import * as sessionModule from '../src/session.js';
```

**Important:** once `fetchPrimo` calls the real `loadSession()`, every pre-existing test in this file that exercises `searchOneSearch`/`getRecord` would otherwise call through to the *actual* `~/.neu-onesearch-mcp/session.json` on whatever machine runs the suite — making those tests pass or fail depending on whether that machine happens to have a real session file. Add a file-level default mock so every test in this file is deterministic regardless of the real filesystem, with only the new cookie-attachment tests overriding it. Place this near the top of the file, after the imports and before the first `describe` block:

```typescript
beforeEach(() => {
  vi.spyOn(sessionModule, 'loadSession').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});
```

Add this new `describe` block (place it after the existing `describe('getRecord', ...)` block, at the end of the file):

```typescript
describe('fetchPrimo cookie attachment', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches a Cookie header when a session is present', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue('JSESSIONID=abc123');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    await searchOneSearch({ query: 'test' });

    const options = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    expect(options?.headers).toEqual({ Cookie: 'JSESSIONID=abc123' });
  });

  it('sends no Cookie header when no session is present', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue(null);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    await searchOneSearch({ query: 'test' });

    const options = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    expect(options?.headers).toBeUndefined();
  });

  it('attaches the Cookie header on getRecord requests too', async () => {
    vi.spyOn(sessionModule, 'loadSession').mockReturnValue('JSESSIONID=abc123');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ info: { total: 0 }, docs: [] }),
    });

    await getRecord('alma1');

    const options = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as
      | RequestInit
      | undefined;
    expect(options?.headers).toEqual({ Cookie: 'JSESSIONID=abc123' });
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/primoClient.test.ts`
Expected: FAIL — the new assertions fail because `fetchPrimo` doesn't yet call `loadSession()` or pass any `headers` option, so `options` is `undefined` in all three new tests (the first two tests fail on the `toEqual`/`toBeUndefined` mismatch for the header-attaching case; the third fails the same way).

- [x] **Step 3: Update `src/primoClient.ts`**

Add this import (alongside the existing `import type` line at the top):

```typescript
import { loadSession } from './session.js';
```

Replace the existing `fetchPrimo` function:

```typescript
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
```

with:

```typescript
async function fetchPrimo(params: URLSearchParams): Promise<PrimoSearchResponse> {
  const cookie = loadSession();
  const response = await fetch(
    `${BASE_URL}?${params.toString()}`,
    cookie ? { headers: { Cookie: cookie } } : undefined
  );
  if (!response.ok) {
    throw new Error(`OneSearch request failed: HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as PrimoSearchResponse;
  } catch {
    throw new Error('OneSearch returned an unparseable response');
  }
}
```

(Every other function in `primoClient.ts` — `buildFacetClause`, `buildSearchParams`, `searchOneSearch`, `getRecord`, `CAMPUS_SCOPES` — is unchanged.)

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/primoClient.test.ts`
Expected: PASS (24 tests: the pre-existing 21 plus the 3 new cookie-attachment tests).

- [x] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS (all tests, zero failures).

- [x] **Step 6: Commit**

```bash
git add src/primoClient.ts test/primoClient.test.ts
git commit -m "feat: attach stored session cookies to OneSearch requests"
```

---

## Task 3: Login CLI

**Files:**
- Modify: `package.json` (add `playwright` dependency)
- Create: `src/login.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `SESSION_PATH` from `src/session.ts` (Task 1).
- Produces: nothing consumed by other source files — `login.ts` is a standalone entrypoint, run directly as `node dist/login.js`.

- [x] **Step 1: Add the `playwright` dependency to `package.json`**

In the `"dependencies"` block, add `playwright` alongside the existing two:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "playwright": "^1.61.1",
    "zod": "^3.25.0"
  },
```

(Every other field in `package.json` is unchanged.)

- [x] **Step 2: Install the new dependency**

Run: `npm install`
Expected: installs without error, adds `playwright` and its browser-binary-download postinstall step. If the postinstall browser download is skipped/fails in this environment (e.g. no network), that's fine for now — it only matters when actually running `login.ts` interactively later.

- [x] **Step 3: Create `src/login.ts`**

```typescript
import { chromium } from 'playwright';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { SESSION_PATH } from './session.js';

const LOGIN_URL = 'https://onesearch.library.northeastern.edu/discovery/login?vid=01NEU_INST:NUL';

async function main(): Promise<void> {
  mkdirSync(dirname(SESSION_PATH), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(LOGIN_URL);

  console.log('A browser window has opened. Please complete the NEU login there.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter once you are logged in... ');
  rl.close();

  await context.storageState({ path: SESSION_PATH });
  chmodSync(SESSION_PATH, 0o600);

  await browser.close();
  console.log(`Session saved to ${SESSION_PATH}`);
}

main().catch((err) => {
  console.error('Login failed:', err);
  process.exitCode = 1;
});
```

- [x] **Step 4: Build and verify it compiles**

Run: `npm run build`
Expected: compiles without error, produces `dist/login.js`.

- [ ] **Step 5: Manual verification (not automated — this is inherently interactive)**

Run: `node dist/login.js`
Expected: a real Chromium window opens to NEU's OneSearch login page; after completing NEU SSO login and pressing Enter in the terminal, the script prints `Session saved to <path>` and exits 0. Confirm `~/.neu-onesearch-mcp/session.json` exists and its permissions are owner-only (`ls -l ~/.neu-onesearch-mcp/session.json` should show `-rw-------`).

This step depends on real NEU credentials and is not part of `npm test` / CI, matching the pattern already established for `scripts/smoke-test.mjs`.

- [x] **Step 6: Update `README.md`**

Add a new section (place it after the existing "Add to Claude Desktop / Claude Code" section, before "Tools"):

```markdown
## Logging in (optional)

Search works fully anonymously with no login. Logging in may improve
full-text/entitlement access for some resources. Run once, outside Claude:

```bash
npm run build
node dist/login.js
```

A real browser window opens to NEU's actual SSO login page — complete your
login there (your password never touches this codebase), then press Enter
in the terminal. Your session is saved to `~/.neu-onesearch-mcp/session.json`
(owner-only permissions) and picked up automatically by `search_onesearch`/
`get_record` from then on. No session file present → fully anonymous
behavior, unchanged from before.

Sessions are not currently auto-detected as expired — if results seem off
after a while, re-run `node dist/login.js`.
```

- [x] **Step 7: Commit**

```bash
git add package.json package-lock.json src/login.ts README.md
git commit -m "feat: add NEU SAML login CLI"
```
