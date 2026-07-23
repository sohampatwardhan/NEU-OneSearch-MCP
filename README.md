# Northeastern University Scholar OneSearch MCP for Claude

An MCP server for [Northeastern University's Scholar OneSearch](https://onesearch.library.northeastern.edu).
Lets Claude search NEU's library catalog and article databases for academic references.

Search works fully anonymously — an optional login exists (see "Logging in" below), but see that section for what it does and doesn't currently do.
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

## Logging in (optional, no current effect on search results)

Search works fully anonymously with no login.
`node dist/login.js` drives a real browser through NEU's actual SSO login and saves the resulting session for `search_onesearch`/`get_record` to attach automatically:

```bash
npm run build
node dist/login.js
```

A real browser window opens to NEU's actual SSO login page — complete your login there (your password never touches this codebase), then press Enter in the terminal.
Your session is saved to `~/.neu-onesearch-mcp/session.json` (owner-only permissions).
No session file present → fully anonymous behavior, unchanged from before.

**Honest status:** live testing (a real login, tested against three different catalog items including one with a full-text proxy link) found **no observable difference** in `search_onesearch`/`get_record` results with a valid session, an invalidated session, or no session at all — same availability, same holdings data, same full-text links, every time.
Logging in does not currently improve anything these two tools return.
It exists as groundwork for features that genuinely need patron identity (e.g. saved favorites/lists, placing holds) — those aren't built yet.
If you don't need those, there's no reason to log in today.

Sessions are not auto-detected as expired, since live testing found nothing to detect at this layer — session validity doesn't appear to affect these API responses at all.

## Tools

- `search_onesearch(query, limit?, resourceType?, dateFrom?, dateTo?, peerReviewedOnly?, sort?, campus?)` — free-text search.
  Only one of `resourceType`, `dateFrom`/`dateTo`, or `peerReviewedOnly` may be set per call — NEU's search API only honors one filter at a time.
  `campus` restricts to one NEU campus/scope (`all` (default), `boston`, `oakland`, or `online`) — `all` is genuine all-campus results (`CDI_plus_all_local`), not just Boston + central index.
- `get_record(recordId)` — fetch full detail (abstract, table of contents, availability, full-text link) for one result from a prior search.
  Only supports NEU catalog records (`recordId` starting with `alma`).

Each mapped result includes both `catalogUrl` and `doiUrl` (when a DOI is present).
`catalogUrl` points at the OneSearch discovery record itself and can show a "sign in or access from campus network" wall for CDI-sourced (`cdi_*`) records if you aren't already signed into OneSearch in that browser — this is Primo VE's own frontend access control, unaffected by anything this server does.
`doiUrl` (`https://doi.org/<doi>`) is a stable link that always resolves to the publisher's landing page and doesn't require an NEU session; prefer it when sharing links or opening them in a fresh browser.

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

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for notable changes.

## License

MIT — see [LICENSE](LICENSE).
