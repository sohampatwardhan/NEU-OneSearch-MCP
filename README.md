# Northeastern University Scholar OneSearch MCP for Claude

[![npm version](https://img.shields.io/npm/v/@sohampatwardhan/neu-onesearch-mcp.svg)](https://www.npmjs.com/package/@sohampatwardhan/neu-onesearch-mcp)

An MCP server for [Northeastern University's Scholar OneSearch](https://onesearch.library.northeastern.edu).
Lets Claude search NEU's library catalog and article databases for academic references.

Search works fully anonymously — an optional login exists (see "Logging in" below), but see that section for what it does and doesn't currently do.
See `docs/superpowers/specs/2026-07-22-onesearch-mcp-design.md` and `docs/superpowers/specs/2026-07-22-onesearch-auth-design.md` for the full design and research behind this.

## Install

The package on npm is `@sohampatwardhan/neu-onesearch-mcp`.
MCP clients start it over stdio:

```sh
npx -y @sohampatwardhan/neu-onesearch-mcp@latest
```

Requires Node.js 20 or later.
The published bin is `neu-onesearch-mcp` (`#!/usr/bin/env node`).
Stdio is the only transport, and the MCP server name is `neu-onesearch-mcp`.
Normally the MCP client launches it, so you don't run it by hand.

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

To run from a clone of this repo instead of npm:

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

## Logging in (optional, no current effect on search results)

Search works fully anonymously with no login.
The `neu-onesearch-login` command drives a real browser through NEU's actual SSO login and saves the resulting session for `search_onesearch`/`get_record` to attach automatically.
It opens your installed Google Chrome, so Chrome must be installed.

From npm:

```bash
npx -y -p @sohampatwardhan/neu-onesearch-mcp@latest neu-onesearch-login
```

From a checkout:

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

Each mapped result includes `catalogUrl`, `doiUrl`, and `ezproxyDoiUrl` (the latter two only when a DOI is present).
`catalogUrl` points at the OneSearch discovery record itself and can show a "sign in or access from campus network" wall for CDI-sourced (`cdi_*`) records if you aren't already signed into OneSearch in that browser — this is Primo VE's own frontend access control, unaffected by anything this server does.
`doiUrl` (`https://doi.org/<doi>`) is a stable link that always resolves to the publisher's landing page and doesn't require an NEU session; prefer it when sharing links or opening them in a fresh browser.
`ezproxyDoiUrl` (`https://doi-org.ezproxy.neu.edu/<doi>`) routes the same DOI through NEU's EZproxy — opening it prompts an NEU sign-in, then forwards through the library's subscriptions to the publisher, unlocking full text for anything NEU has access to. Use this one when you (as an NEU user) want authenticated full-text access rather than just the public landing page.

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

## Releasing

Releases publish from `v*` tags through `.github/workflows/release.yml`, using npm trusted publishing (GitHub OIDC, no `NPM_TOKEN`) with provenance, and mirror the same version to GitHub Packages.

### First publish (one time)

npm can only attach a trusted publisher to a package that already exists on the registry, so the owner publishes the first version once from a maintainer machine:

```sh
npm login
npm ci
npm publish --access public
```

Leave `--provenance` off for that local publish.
Provenance is added by the GitHub Actions workflow, which has the OIDC token.
Don't push a tag for that version: the workflow would try to publish it again.

Then, on npmjs.com, open `@sohampatwardhan/neu-onesearch-mcp` → Settings → Trusted publishing, choose GitHub Actions, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `sohampatwardhan` |
| Repository | `NEU-OneSearch-MCP` |
| Workflow filename | `release.yml` |
| Environment name | empty |

The filename is `release.yml` only, not `.github/workflows/release.yml`.
Allow direct `npm publish`: a publisher created after 3 September 2026 starts with only `npm stage publish` allowed.
Leave dist-tag management off.
The same link can be created with npm CLI 11.15.0 or newer (2FA must be enabled on the account):

```sh
npm trust github @sohampatwardhan/neu-onesearch-mcp \
  --repo sohampatwardhan/NEU-OneSearch-MCP \
  --file release.yml \
  --allow-publish
```

The first publish from the workflow has to succeed within two days of saving the publisher, or the configuration expires.

### Later releases

```sh
npm version patch   # or minor, or major
git push --follow-tags
```

`npm version` writes the version and a `vX.Y.Z` tag.
The release workflow runs on that tag (or on a manual run that names the tag), refuses the job when the tag is not `v` plus the `package.json` version, runs `npm ci`, typecheck, build, and tests, publishes with `npm publish --provenance --access public`, opens a GitHub Release with generated notes, and then publishes the same version to GitHub Packages.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for notable changes.

## License

MIT — see [LICENSE](LICENSE).
