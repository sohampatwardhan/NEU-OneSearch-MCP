# Northeastern University Scholar OneSearch MCP for Claude

An MCP server for [Northeastern University's Scholar OneSearch](https://onesearch.library.northeastern.edu).
Lets an agent search NEU's library catalog and, after a one-time NU IT sign-in, retrieve entitled full text through the library's EZproxy for the student to synthesize.

Search and record metadata work fully anonymously. Login does not change those results. It exists so `get_full_text` can download a subscribed PDF or HTML page through EZproxy and return extracted plain text. See "Logging in" and "What login does and does not unlock" below.
See `docs/superpowers/specs/2026-07-22-onesearch-mcp-design.md` and `docs/superpowers/specs/2026-07-22-onesearch-auth-design.md` for the full design and research behind this.

## Setup

```bash
npm install
npm run build
```

## Install into Claude Code / Claude Desktop / Codex CLI

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

## Logging in (required only for full text)

Search works with no login. Full text does not.

`node dist/login.js` opens your installed Chrome, walks through NEU's real SSO, then opens the library proxy so EZproxy can set its own session cookie. The password is typed only on NU IT's page.

```bash
npm run build
node dist/login.js
```

1. A browser opens on Scholar OneSearch. Sign in there, then press Enter in the terminal.
2. The same window opens an EZproxy link. Approve any extra NU IT / Duo prompt. If the page says "Authenticate with Northeastern credentials", finish that. Press Enter if the tool asks.
3. The script writes `~/.neu-onesearch-mcp/session.json` and says whether an EZproxy cookie was captured.

Set `NEU_ONESEARCH_SESSION_PATH` if the session file should live somewhere else. That is a path only. There is no environment variable for a password or a raw cookie value.

The MCP server and `node dist/login.js` must run as the same user on the same machine, so the server can read the file the login script wrote. Delete the file to sign out.

### Session file privacy

The file is a live library session: anyone who can read it can use the proxy as you until EZproxy expires it. It is written with mode `0600` (owner read/write only) and it lives outside the repo. Do not commit it, paste it into chat, or copy it to another computer. This project never asks for, stores, or logs your password. Cookie values are not included in tool results.

### What login does and does not unlock

Live checks of `search_onesearch` and `get_record` (a real login, then the same items with a valid session, a broken session, and no session) returned the same availability, holdings, and links every time. Attaching the OneSearch cookie does not add subscription-database hits or change full-text links. Those two tools stay anonymous in behavior even when a session file exists: only OneSearch-scoped cookies are sent to the catalog API, and they have not changed its responses.

Article entitlement is a different system. NEU's library proxy is EZproxy (`link.ezproxy.neu.edu` / `*.ezproxy.neu.edu`). Opening a subscribed DOI through that proxy, after NU IT sign-in, is what reaches the publisher. `get_full_text` uses the EZproxy cookie from the login script. An older session file from before this step, or a login you abandoned on the OneSearch page, does not contain that cookie. `get_full_text` says so and asks you to run login again.

Patron features that need an Alma identity (saved lists, holds, request history) are still not implemented.

## Tools

- `search_onesearch(query, limit?, resourceType?, dateFrom?, dateTo?, peerReviewedOnly?, sort?, campus?)` — free-text search.
  Only one of `resourceType`, `dateFrom`/`dateTo`, or `peerReviewedOnly` may be set per call — NEU's search API only honors one filter at a time.
  `campus` restricts to one NEU campus/scope (`all` (default), `boston`, `oakland`, or `online`) — `all` is genuine all-campus results (`CDI_plus_all_local`), not just Boston + central index.
- `get_record(recordId)` — fetch full detail (abstract, table of contents, availability, full-text link) for one result from a prior search.
  Only supports NEU catalog records (`recordId` starting with `alma`). This is metadata and links, not the article body.
- `get_full_text(doi?, recordId?)` — download one entitled item through EZproxy and return extracted plain text.
  Pass `doi` from a `search_onesearch` result. That works for CDI articles (`cdi_*` ids) and for catalog records. `get_record` cannot open CDI ids; the DOI can.
  `recordId` is only for `alma` records, and only when you do not already have a DOI. If both are set, the DOI is used.
  The result is JSON. `status` is the contract:

  | `status` | Meaning |
  | --- | --- |
  | `ok` | Extracted text the agent can synthesize. `via` is `pdf` or `html`. |
  | `partial` | Some text, but it may be an abstract, a landing page, or a mix of article and access prompts. |
  | `login_required` | No usable EZproxy cookie, or the proxy showed NU IT sign-in. `sourceUrl` is the proxy link to open, or to retry after `node dist/login.js`. |
  | `not_entitled` | The session was sent, and the publisher or proxy still refused (HTTP 401/403 or an access wall). NEU may not subscribe to that item. |
  | `not_found` | The DOI or catalog id did not resolve. |
  | `too_large` | The download exceeded 20 MiB (20,971,520 bytes) and was not parsed. |
  | `unsupported` | Not HTML or a readable PDF: scanned image, encrypted PDF, DRM, CAPTCHA, or a page that only renders text in JavaScript. |
  | `error` | The DOI was unusable, the record id was not an `alma` id, or the proxy request failed. |

  `text` is plain text, never the original PDF. `sourceUrl`, `contentType`, `pageCount`, and `pagesExtracted` describe where it came from. `truncated` is true when the extract hit a cap. `limits` repeats the caps: 20 MiB download, 40 PDF pages, 100,000 characters. A book-length PDF returns the first 40 pages, not the whole book.

Each mapped result includes `catalogUrl`, `doiUrl`, and `ezproxyDoiUrl` (the latter two only when a DOI is present).
`catalogUrl` points at the OneSearch discovery record itself and can show a "sign in or access from campus network" wall for CDI-sourced (`cdi_*`) records if you aren't already signed into OneSearch in that browser — this is Primo VE's own frontend access control, unaffected by anything this server does.
`doiUrl` (`https://doi.org/<doi>`) is a stable link that always resolves to the publisher's landing page and doesn't require an NEU session; prefer it when sharing links or opening them in a fresh browser.
`ezproxyDoiUrl` (`https://doi-org.ezproxy.neu.edu/<doi>`) is the same DOI routed through NEU's EZproxy hostname form. Opening it in a browser prompts an NEU sign-in, then forwards through the library's subscriptions. `get_full_text` uses the equivalent library prefix `https://link.ezproxy.neu.edu/login?url=https://doi.org/<doi>`, which is also how Primo's "view online" links and the library bookmarklet authenticate. Use `get_full_text` when the agent needs the words. Use `ezproxyDoiUrl` when a person should open the publisher page themselves.

### How an agent should call full text

1. `search_onesearch` for the topic. No login required.
2. From a promising result, call `get_full_text` with that result's `doi`.
3. If `status` is `login_required`, tell the student to run `node dist/login.js` once in a terminal, then call `get_full_text` again. Do not ask them to paste a password or a cookie.
4. Synthesize only from `text` when `status` is `ok`. For `partial` or `not_entitled`, say that the library copy was incomplete and quote only what was actually returned.
5. `sourceUrl` is the proxied link if the student wants the original PDF or HTML in a browser.

### Limits that still apply after a successful login

- The server does not run the publisher's JavaScript. If the article body is injected by a script and there is no `citation_pdf_url` (or other PDF link) in the HTML, the extract is the landing page, not the article.
- CAPTCHAs and "verify you are human" walls are returned as `unsupported`. They are not solved.
- Scanned or image-only PDFs have no text layer. There is no OCR. Encrypted PDFs are not decrypted.
- Some publishers block non-browser clients even with a valid proxy cookie and a browser-like User-Agent. That shows up as `not_entitled`, `unsupported`, or a short `partial` extract.
- EZproxy will not proxy a host the library has not configured. A DOI that resolves to such a host fails even if the session is valid.
- NEU not subscribing is a normal outcome. Login does not create access the library has not licensed.
- This retrieves one item per call for the signed-in student's own research. It is not a bulk downloader, and the text is for synthesis in the conversation, not for republishing the article.

## Development

```bash
npm run dev    # run the server directly via tsx, for manual stdio testing
npm test       # run the automated test suite
```

## Manual live smoke test

Hits the real OneSearch endpoint — not part of `npm test`, run manually to confirm the (unofficial) endpoint still behaves as expected:

```bash
npm run build && node scripts/smoke-test.mjs
```

### Full text (needs your own NU IT login)

Not part of `npm test`. No cookie is committed with this repo. After `node dist/login.js` prints that an EZproxy session was captured:

```bash
node scripts/fulltext-smoke.mjs
node scripts/fulltext-smoke.mjs 10.1038/s41586-020-2649-2
```

The default DOI is an open-access PLOS ONE article, so a working proxy session can be checked without depending on a particular subscription. The second example is a Nature article and only returns body text when NEU's license and that publisher both allow this client through.

Expect `status: "ok"` or `"partial"` and a short text preview. Without a session file, the script prints `login_required` and does not pretend to have the article. `search_onesearch` in `scripts/smoke-test.mjs` should still succeed if you temporarily rename the session file.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for notable changes.

## License

MIT — see [LICENSE](LICENSE).
