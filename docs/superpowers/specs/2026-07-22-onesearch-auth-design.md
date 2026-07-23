# NEU OneSearch MCP Server — Authentication Design

## Purpose

Add NEU SAML login support to the OneSearch MCP server so that, once a
student signs in, the existing `search_onesearch`/`get_record` tools can
attach the resulting session automatically — improving full-text/entitlement
access without requiring any new tool surface. This is the foundational
piece for later personalized features (saved favorites/lists), which remain
explicitly out of scope here pending their own endpoint research.

## Why this needs a real browser

NEU's Primo VE uses SAML SSO (confirmed live: `authentication-system: SAML`,
profile `VEsamlprod`, silent login disabled, via
`primaws/rest/pub/configuration/vid/01NEU_INST:NUL`). The login redirect is
triggered client-side by OneSearch's Angular app (a plain `curl` to
`/discovery/login` just returns the SPA shell; the real redirect chain runs
through `/primaws/suprimaLogin`, which needs client-computed parameters).
There is no simple URL a server-side HTTP client can follow — this has to be
driven by an actual browser.

## Why not MCP's built-in auth mechanisms

Two MCP-native mechanisms were considered and ruled out for this project,
both confirmed via research rather than assumed:

- **MCP OAuth authorization flow** (the mechanism behind remote servers like
  GitHub's and Context7's "reauthenticate" prompts) applies to **remote,
  HTTP-transport** MCP servers, where the client manages a browser-based
  OAuth handshake against the server's own OAuth provider. Our server is
  local stdio, and Primo VE has no OAuth provider of its own (it's SAML) —
  adopting this would mean rebuilding as a remote HTTP server *and*
  constructing an OAuth-provider shim in front of NEU's SAML backend, a much
  larger project than warranted here.
- **Elicitation** (`elicitInput({mode: 'url', ...})`, letting a tool call
  pause mid-execution to prompt an in-browser sign-in) is the closer
  mechanism, but confirmed **not implemented by Claude Code today** (open,
  unresolved GitHub issue #2799). A server calling it would error or time
  out.

Given both are unavailable, login is a standalone CLI step run once outside
Claude, with tool responses telling the user plainly when to re-run it.

## Design

**Login flow (`src/login.ts`, run as `node dist/login.js`):**
1. Launch a visible (non-headless) Playwright browser.
2. Navigate to `https://onesearch.library.northeastern.edu/discovery/login?vid=01NEU_INST:NUL`
   — the app's own JS drives the real SAML redirect chain, exactly as it
   would for a normal user.
3. The user completes NEU's actual SSO login in that window. The MCP
   server/this script never sees the password.
4. The CLI prompts "press Enter once you're logged in" — a manual
   confirmation checkpoint, chosen over guessing at DOM selectors for a
   "logged in" state that can't be verified without a real NEU account and
   could break silently if Primo VE's UI changes.
5. Capture `context.storageState()` (cookies + local storage) and write it
   to `~/.neu-onesearch-mcp/session.json`, permissions `0600` (owner
   read/write only) — outside the repo, since it holds live session data.

**Using the session (`src/primoClient.ts`):**
- New `loadSession()`: reads the session file if present and parses it into
  a `Cookie` header value. Returns `null` if the file is missing, unreadable,
  or malformed — never throws.
- `fetchPrimo` attaches the `Cookie` header when `loadSession()` returns a
  value. With no session file, every request is byte-for-byte identical to
  today's fully anonymous behavior — this is strictly additive.

**Staleness handling:**
- No timestamp-based pre-expiry guessing — the real behavior of Alma's
  30-minute session-timeout config setting (inactivity reset vs. hard
  expiry) is unverified, and guessing wrong would either discard valid
  sessions early or trust expired ones.
- The exact signal that distinguishes "session expired" from "genuinely no
  matches" in a Primo response is unverified — there's no authenticated
  response sample yet to know its shape. The implementation task must
  include a manual spike (log in for real, let the session sit past 30
  minutes, compare an authenticated request's response before and after)
  to determine the actual signal before writing the staleness-detection
  code, rather than guessing at a heuristic now. Once that signal is known:
  a cookie-attached request that trips it retries the same request without
  cookies (anonymous) rather than hard-failing the tool call, and the tool's
  response text notes plainly that the session appears to have expired and
  to re-run `node dist/login.js` — visible user guidance, not a silent
  fallback.

## Out of scope (for this spec)

- Any new MCP tool surface (e.g. favorites/saved lists) — needs its own
  endpoint research first, as a follow-on spec.
- Remote/HTTP hosting (e.g. Cloudflare Workers) — validated as technically
  feasible and the best free option if pursued later, but doesn't solve this
  spec's auth problem (no server-side account linking the way OAuth-based
  remote servers have) and reopens the project's local-stdio-only
  constraint. Tracked in memory, not pursued here.
- MCP elicitation-based reauthentication — blocked on Claude Code client
  support (currently unimplemented); revisit if that changes.

## Testing

- `loadSession()`/cookie-attachment logic in `primoClient.ts`: unit tests
  with a mocked filesystem (session file present/absent/malformed).
- `login.ts` is inherently interactive and cannot be automated — documented
  as a manual verification step, the same pattern already established for
  `scripts/smoke-test.mjs`.
