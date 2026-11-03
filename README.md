# Northeastern University Scholar OneSearch MCP for Claude

[![npm version](https://img.shields.io/npm/v/@sohampatwardhan/neu-onesearch-mcp.svg)](https://www.npmjs.com/package/@sohampatwardhan/neu-onesearch-mcp)

An MCP server for [Northeastern University's Scholar OneSearch](https://onesearch.library.northeastern.edu).
Lets Claude search NEU's library catalog and article databases for academic references.

Search works fully anonymously. A one-time NEU sign-in (see "Signing in" below) caches a library
session on your device so features that need it can reuse it, and so tools report `login_required`
instead of failing silently when it expires.
See `docs/superpowers/specs/2026-07-22-onesearch-mcp-design.md` and `docs/superpowers/specs/2026-07-22-onesearch-auth-design.md`,
and the spec in `.kiro/specs/shibboleth-auth/`, for the full design and research behind this.

## Install

The server is published on npm as [`@sohampatwardhan/neu-onesearch-mcp`](https://www.npmjs.com/package/@sohampatwardhan/neu-onesearch-mcp),
so there is nothing to clone or build. Your MCP client runs it with `npx`:

```sh
npx -y @sohampatwardhan/neu-onesearch-mcp@latest
```

Requires Node.js 20 or later. Stdio is the only transport, and the MCP server name is `neu-onesearch-mcp`.
Normally the MCP client launches it, so you don't run it by hand. `@latest` makes `npx` pick up new
releases when the client restarts.

Quick start:

1. Add the server to your client using one of the snippets below, then restart the client.
2. Search works straight away, anonymously.
3. Optionally sign in once for features that need a Northeastern session (see [Signing in](#signing-in)):

   ```bash
   npx -y -p @sohampatwardhan/neu-onesearch-mcp@latest neu-onesearch-login
   ```

### Claude Code

```bash
claude mcp add --scope user neu-onesearch -- npx -y @sohampatwardhan/neu-onesearch-mcp@latest
```

### Codex CLI

```bash
codex mcp add neu-onesearch -- npx -y @sohampatwardhan/neu-onesearch-mcp@latest
```

### Claude Desktop

Add this to the desktop config, then restart Claude Desktop:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "neu-onesearch": {
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/neu-onesearch-mcp@latest"]
    }
  }
}
```

### Kiro and Cursor

Add the same entry to `~/.kiro/settings/mcp.json` (Kiro) or `~/.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "neu-onesearch": {
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/neu-onesearch-mcp@latest"]
    }
  }
}
```

### Generic stdio

Any MCP client that launches a local process uses the same command.
Field names vary (`mcpServers` vs `servers`, and some clients omit `type`).
Antigravity takes this entry in `mcp_config.json` (MCP store → "Manage MCP Servers" → "View raw config").

```json
{
  "mcpServers": {
    "neu-onesearch": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/neu-onesearch-mcp@latest"]
    }
  }
}
```

## Install from a checkout

Only needed for development, or to try unreleased changes. To run from a clone of this repo instead of npm:

```bash
npm install
npm run build
```

`npm run install-mcp` registers the server with whichever of Claude Code, Claude Desktop, and Codex CLI are installed on your machine — Mac, Linux, and Windows are all supported (Claude Desktop is skipped on Linux since Anthropic doesn't ship a Linux build there).
Each target is detected independently, so anything not installed is skipped rather than failing the run, and it's safe to re-run — it updates the existing entry instead of duplicating it.

```bash
npm run build
npm run install-mcp
```

Restart the relevant app/CLI afterwards to pick up the new server.

### Manual setup

To add it by hand instead — or to a client the script doesn't cover — use the absolute path to this repo's `dist/index.js` (after `npm run build`).

**Claude Code:**

```bash
claude mcp add --scope user neu-onesearch -- node /absolute/path/to/NEU-OneSearch-MCP/dist/index.js
```

**Codex CLI:**

```bash
codex mcp add neu-onesearch -- node /absolute/path/to/NEU-OneSearch-MCP/dist/index.js
```

**Antigravity:** open the MCP store → "Manage MCP Servers" → "View raw config", then add the same `mcpServers` entry shown below to `mcp_config.json`.
Antigravity has no CLI or documented config path, so it isn't handled by `install-mcp`.

**Claude Desktop (or manual config for any client):** add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "neu-onesearch": {
      "command": "node",
      "args": ["/absolute/path/to/NEU-OneSearch-MCP/dist/index.js"]
    }
  }
}
```

## Signing in

Search and record metadata work fully anonymously, with no login. Sign-in exists so that
features needing an authenticated Northeastern session (full text through the library EZproxy)
can reuse your session, and so the tools can tell you clearly when that session has expired.
Your password is only ever typed on NU IT's own page — this project never sees, stores, or logs it.

Sign-in drives a dedicated Google Chrome profile, so Chrome must be installed. It uses its own
profile (not your everyday Chrome), because Chrome blocks automation on the normal profile and
ties its cookie encryption to it.

From a checkout:

```bash
npm run build
node dist/login.js      # or: neu-onesearch-login
```

From npm:

```bash
npx -y -p @sohampatwardhan/neu-onesearch-mcp@latest neu-onesearch-login
```

What happens:

1. A dedicated Chrome window opens on Scholar OneSearch. Complete NEU's real SSO (SAML + Duo)
   there, then press Enter in the terminal.
2. The same window opens a library EZproxy link so EZproxy sets its own session cookie. Approve
   any extra NU IT / Duo prompt. If the page says "Authenticate with Northeastern credentials",
   finish that.
3. The OneSearch and EZproxy session cookies, plus the capture time, are cached on your device.
   The command reports whether an EZproxy cookie was captured — by cookie name only, never by value.

### Where the session lives

Everything is under `~/.cache/neu-onesearch-mcp/`, owner-only:

| Path | Permissions | Contents |
| --- | --- | --- |
| `profile/` | `0700` | the dedicated Chrome profile (keeps the NU IdP session and Duo "remember this device") |
| `session.json` | `0600` | the captured cookies and capture time — a live library session, no password |

Set `NEU_ONESEARCH_CACHE_DIR` to move this directory. That is a path only; there is no environment
variable for a password or a raw cookie. The MCP server and the login command must run as the same
user on the same machine. Do not commit `session.json`, paste it into chat, or copy it to another
computer — anyone who can read it can use the proxy as you until the session expires.

### Session lifetime and re-login

NEU / EZproxy set the session lifetime; for v1 it is treated as short (roughly one hour — to be
confirmed by a live measurement). There is no refresh token. When a session expires, tools return a
`login_required` result telling you to run the login command again — they never fail silently. Because
the dedicated profile keeps your NU IdP session and Duo's "remember this device", a re-login while that
IdP session is still alive is usually one click or one Duo push, with no password.

### Signing out

From npm:

```bash
npx -y -p @sohampatwardhan/neu-onesearch-mcp@latest neu-onesearch-logout
```

From a checkout:

```bash
node dist/logout.js
```

`neu-onesearch-logout` is available from 0.2.0; on 0.1.2, delete `~/.cache/neu-onesearch-mcp/` by hand.

This deletes `session.json` and the `profile/` directory. It is safe to run when you are already
signed out. After logout, a tool that needs the session returns `login_required`.

### Running on a remote machine (e.g. a server, Grok Bot box, or Muse)

Sign-in needs an interactive browser, and a localhost OAuth callback cannot capture SAML cookies from
another machine. Two paths:

- **Today:** sign in on the server itself over a remote desktop (for example a Tailscale connection to
  that box), so the dedicated Chrome window and your Duo prompt appear where you can complete them. The
  cached session then lives on the server for the MCP running there.
- **Later:** a small browser extension could post the captured cookies to the MCP's local endpoint
  (`127.0.0.1` or a Tailscale IP). This is not built yet; it is noted as the intended remote path. A
  remote HTTP transport with an OAuth-to-SAML shim is tracked separately (see issue #1) and is out of
  scope here.

### What signing in does and does not change

Live testing of `search_onesearch` and `get_record` found no observable difference between a valid
session, an expired session, and no session at all — those two tools stay anonymous in behavior, and a
cached session does not change their metadata results. Signing in matters for authenticated full-text
access through EZproxy (a separate tool, tracked in issue #2) and for surfacing `login_required` when the
session is gone. Patron features that need an Alma identity (saved lists, holds, request history) are not
implemented.

## Tools

- `search_onesearch(query, limit?, resourceType?, dateFrom?, dateTo?, peerReviewedOnly?, sort?, campus?)` — free-text search.
  `resourceType`, `dateFrom`/`dateTo`, and `peerReviewedOnly` combine (AND) in a single call.
  `campus` restricts to one NEU campus/scope (`all` (default), `boston`, `oakland`, or `online`) — `all` is genuine all-campus results (`CDI_plus_all_local`), not just Boston + central index.
- `get_record(recordId)` — fetch full detail (abstract, table of contents, availability, full-text link) for one result from a prior search.
  Accepts catalog records (`recordId` starting with `alma`) and Central Discovery Index articles (`recordId` starting with `cdi_`).
- `get_full_text(doi?, recordId?)` — retrieve and extract the plain text of a subscribed article, fetched through NEU EZproxy (which needs the cached sign-in session), with direct and open-access fallbacks that do not.
  Pass a DOI (preferred, from a prior `search_onesearch` result) or an `alma` or `cdi_` record id. The tool routes the link through EZproxy, downloads the PDF or HTML, and returns extracted text with caps (about 20 MiB download, 40 PDF pages, 100k characters).
  The result is JSON with a `status` and never contains any cookie value:

  | `status` | Meaning |
  | --- | --- |
  | `ok` | Full text extracted. `via` is `pdf` or `html`; `text` holds the extracted content. |
  | `partial` | Some text, but likely an abstract/landing page or mixed with access-wall prompts. `textKind` says `abstract` for abstract-only text (for example ScienceDirect pages through the proxy) or `unknown`. |
  | `login_required` | No usable EZproxy session (missing, OneSearch-only, expired, or rejected). Run `neu-onesearch-login` and finish the EZproxy step. Without a session no request goes to the library proxy, but the open-access fallback may still query OpenAlex and fetch open-access copies (never with cookies); if it finds one, the status is `ok` instead. |
  | `not_proxied` | EZproxy passed the request through to a publisher it does not proxy (usually open access, such as PLOS), and a direct fetch of that page did not yield text. `sourceUrl` is the publisher URL to open. Signing in again will not help. |
  | `not_entitled` | A publisher access wall or HTTP 401/403 — NEU may not subscribe, or the publisher blocked the download. |
  | `not_found` | The record or proxied URL returned nothing (404). |
  | `too_large` | The download exceeded the size cap and was not parsed. |
  | `blocked` | The publisher refused automated access: a bot check, challenge or CAPTCHA page, an EZproxy "wait a moment ... click here" interstitial, or a 403 from a direct cookie-less fetch. Open `readUrl` in a browser and handle any check there. This server never solves or bypasses checks. |
  | `unsupported` | No DOI/full-text link, or a non-text or image-only response. This server does not OCR. Bot walls are reported as `blocked`, not `unsupported`. |
  | `error` | Bad input (no/invalid `doi` or unsupported `recordId` prefix) or a transport failure. |

  When EZproxy hands back an unproxied publisher URL, the tool fetches that page (and its `citation_pdf_url`) directly, with no session cookie, and returns `ok`/`partial` with a message saying so. Direct fetches only go to public http(s) hosts: every hop's hostname must resolve to public addresses only.

  Result fields that tell you what you got:

  - `fullText` is `true` only for `ok`. When it is `false`, tell the user the full text was not retrieved and why.
  - `readUrl` is a link the user can open in their browser whenever `fullText` is `false`: the EZproxy `login?qurl=` link for proxied publishers, or the publisher URL for publishers not on the proxy. It is `null` when there was no usable target. Messages for `fullText: false` start with "Full text was not retrieved: " (or "Abstract only. Full text was not retrieved: ") and end with "Open it in a browser: <readUrl>".
  - `textKind` is `article` for `ok`, `abstract` for an abstract-only `partial`, and `unknown` for any other `partial`.
  - `version` is `null` for the publisher's version, or `published`, `accepted`, `submitted` or `unknown` for an open-access copy.

  Open-access fallback: after `blocked`, `not_proxied`, `not_entitled`, `login_required` (this works with no session at all) or an abstract-only result, and when a DOI is known, the tool asks OpenAlex (no key needed) for open-access copies and tries up to 3 of them, never sending cookies. Success returns `ok` with `version` set. Elsevier `linkinghub` redirects are followed. Each call has an overall 60-second deadline; a timeout still returns a result with `readUrl`.

  Every result also carries `via`, `sourceUrl`, `title`, `truncated`, and `charCount`. Unlike `search_onesearch` and `get_record`, the EZproxy path of `get_full_text` requires a live EZproxy session — a OneSearch-only login does not unlock it. Open-access copies (publishers not on the proxy, and OpenAlex copies) need no session.

When a cached session has been attached and NEU bounces the request to sign in (or rejects the cookie with 401/403), a tool returns a JSON result with `"status": "login_required"` and a message telling you to run the login command again, instead of failing silently or returning an empty result. With no cached session, behavior is unchanged anonymous search.

Each mapped result includes `catalogUrl`, `doiUrl`, and `ezproxyDoiUrl` (the latter two only when a DOI is present).
`catalogUrl` points at the OneSearch discovery record itself and can show a "sign in or access from campus network" wall for CDI-sourced (`cdi_*`) records if you aren't already signed into OneSearch in that browser — this is Primo VE's own frontend access control, unaffected by anything this server does.
`doiUrl` (`https://doi.org/<doi>`) is a stable link that always resolves to the publisher's landing page and doesn't require an NEU session; prefer it when sharing links or opening them in a fresh browser.
`ezproxyDoiUrl` (`https://doi-org.ezproxy.neu.edu/<doi>`) routes the same DOI through NEU's EZproxy — opening it prompts an NEU sign-in, then forwards through the library's subscriptions to the publisher, unlocking full text for anything NEU has access to. Use this one when you (as an NEU user) want authenticated full-text access rather than just the public landing page.

## Agent skill

A bundled skill, `neu-literature-review`, teaches an agent the whole literature-review workflow with these tools: searching with combined filters, triaging by abstract, fetching full text, and being honest when the full text is not retrieved. Install it with:

```sh
npx skills add sohampatwardhan/NEU-OneSearch-MCP --skill neu-literature-review
```

Add `-a <agent>` to target one agent or `-g` to install globally. The `skills` CLI needs Node 22.20 or later; that is a requirement of the CLI, not of this server.

## Development

```bash
npm run dev        # run the server directly via tsx, for manual stdio testing
npm start          # run the built server: node dist/index.js
npm run typecheck  # tsc --noEmit
npm test           # run the automated test suite
```

CI (`.github/workflows/ci.yml`) runs typecheck, build, tests, and `npm pack --dry-run` on every push and pull request.

## Manual live smoke test

Hits the real OneSearch endpoint — not part of `npm test`, run manually to confirm the (unofficial) endpoint still behaves as expected:

```bash
npm run build && node scripts/smoke-test.mjs
```

### Full-text smoke test (human, needs a live EZproxy session)

`get_full_text` is exercised against mocked EZproxy and publisher responses in `npm test`, so the
automated suite never needs an NU account. To confirm a real retrieval end to end, sign in first,
then run the script against a built `dist/`:

```bash
node dist/login.js                 # or: neu-onesearch-login — finish the EZproxy step
npm run build && node scripts/fulltext-smoke.mjs
# optionally pass your own DOI:
node scripts/fulltext-smoke.mjs 10.1038/s41586-020-2649-2
```

It prints the status and a short text preview. With no DOI argument it uses the open-access probe
article. The script exits non-zero on `login_required` (run the login command and retry) or any
non-text result, and `0` when it extracts text.

### Manual sign-in smoke test (human, needs Chrome + an NU account)

The automated suite mocks the browser and the IdP, so it never performs a real sign-in. On a machine
with Google Chrome and NU IT credentials, verify the end-to-end flow by hand:

1. `node dist/login.js` — complete SSO + Duo, confirm the "EZproxy session captured" line.
2. Call a tool and confirm it reuses the cached session.
3. Let the session sit until it expires (this also measures the real lifetime to replace the
   "roughly one hour" estimate above), then confirm a tool returns `login_required`.
4. `node dist/logout.js` — confirm `~/.cache/neu-onesearch-mcp/session.json` and `profile/` are gone.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for notable changes.

## License

MIT — see [LICENSE](LICENSE).
