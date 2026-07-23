# NEU-OneSearch-MCP

An MCP server for Northeastern University's Scholar OneSearch
(https://onesearch.library.northeastern.edu). Lets Claude search NEU's
library catalog and article databases for academic references.

Search-only: no login, no personal account features. See
`docs/superpowers/specs/2026-07-22-onesearch-mcp-design.md` for the full
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

## Tools

- `search_onesearch(query, limit?, resourceType?, dateFrom?, dateTo?, peerReviewedOnly?, sort?)` —
  free-text search. Only one of `resourceType`, `dateFrom`/`dateTo`, or
  `peerReviewedOnly` may be set per call — NEU's search API only honors one
  filter at a time.
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
