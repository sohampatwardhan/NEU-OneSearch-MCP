# NEU-OneSearch-MCP

An MCP server for Northeastern University's Scholar OneSearch
(https://onesearch.library.northeastern.edu). Lets Claude search NEU's
library catalog and article databases for academic references.

Search works fully anonymously; an optional login unlocks
personalized/entitlement-aware results for some resources (see "Logging in"
below). See `docs/superpowers/specs/2026-07-22-onesearch-mcp-design.md` and
`docs/superpowers/specs/2026-07-22-onesearch-auth-design.md` for the full
design and research behind this.

## Setup

```bash
npm install
npm run build
```

## Add to Claude Desktop / Claude Code

Add to your MCP config (e.g. `claude_desktop_config.json`), using the
absolute path to this repo:

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

## Tools

- `search_onesearch(query, limit?, resourceType?, dateFrom?, dateTo?, peerReviewedOnly?, sort?, campus?)` —
  free-text search. Only one of `resourceType`, `dateFrom`/`dateTo`, or
  `peerReviewedOnly` may be set per call — NEU's search API only honors one
  filter at a time. `campus` restricts to one NEU campus/scope (`all`
  (default), `boston`, `oakland`, or `online`) — `all` is genuine all-campus
  results (`CDI_plus_all_local`), not just Boston + central index.
- `get_record(recordId)` — fetch full detail (abstract, table of contents,
  availability, full-text link) for one result from a prior search. Only
  supports NEU catalog records (`recordId` starting with `alma`).

## Development

```bash
npm run dev    # run the server directly via tsx, for manual stdio testing
npm test       # run the automated test suite
```

## Manual live smoke test

Hits the real OneSearch endpoint — not part of `npm test`, run manually to
confirm the (unofficial) endpoint still behaves as expected:

```bash
npm run build && node scripts/smoke-test.mjs
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for notable changes.

## License

MIT — see [LICENSE](LICENSE).
