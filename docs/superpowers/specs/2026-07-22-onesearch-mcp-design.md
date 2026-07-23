# NEU OneSearch MCP Server — Design

## Purpose

An MCP server that lets Claude (Desktop/Code) search Northeastern University's
Scholar OneSearch (https://onesearch.library.northeastern.edu) for academic
references and university library resources — as a research assistant tool,
not a full library-account client.

## Scope decisions

- **Search only, no personal account / login.** No NU SSO, no saved
  favorites, no loan/hold status. Northeastern's "sign in" on OneSearch goes
  through Alma's PDS → NU institutional SSO (Shibboleth/Azure AD), which is
  not something a third-party app can register an OAuth client for without
  NU IT/library-admin cooperation. Out of scope for this project.
- **Primary use case:** open-ended research search — find papers, books,
  articles by topic/author/keyword; get citation info and a link back to the
  full text or catalog record.
- **Local stdio MCP server only.** Runs as a local process added to Claude
  Desktop/Code config. No hosting, no remote deployment.
- **TypeScript/Node.js**, using `@modelcontextprotocol/sdk`.

## How search works (research finding)

OneSearch runs on Ex Libris Primo VE. Two possible APIs exist:

1. **Official Primo Search API** (`/primo/v1/search`) — requires an API key
   that only NEU library IT can issue via the Ex Libris Developer Network.
   Not accessible to this project.
2. **Internal frontend API** (`primaws/rest/pub/pnxs`) — the exact JSON
   endpoint the OneSearch web UI itself calls to render search results.
   Verified live and working with **no API key and no login required**:

   ```
   GET https://onesearch.library.northeastern.edu/primaws/rest/pub/pnxs
     ?q=any,contains,<query>
     &vid=01NEU_INST:NUL
     &inst=01NEU_INST
     &scope=MyInst_and_CI
     &tab=Everything
     &mode=advanced
     &offset=0&limit=10&sort=rank
     &skipDelivery=N   (set to N to get full-text/availability links)
   ```

   Returns structured JSON: result count, per-document `pnx.display`
   (title, creator, type, format, date, identifiers, description, subject),
   `pnx.addata` (author parts, ISBN/DOI, abstract), and — when
   `skipDelivery=N` — a `delivery` block with availability status and direct
   links (proxy full-text links, catalog "GetIt" links, thumbnails).

   This is the endpoint the server will use. It is undocumented/unofficial —
   Ex Libris does not guarantee its stability — so the client code must parse
   defensively and fail cleanly if the shape changes.

Headless-browser scraping of the rendered search page was considered and
rejected: it would return the same data as (2) but slower, more fragile to
UI changes, and with a heavier dependency (Puppeteer) for no benefit.

## Architecture

Single TypeScript package, MCP server over stdio transport.

```
src/
  index.ts        # MCP server setup, registers tools
  primoClient.ts  # builds requests to primaws/pnxs, NEU-specific constants
  mapper.ts       # flattens raw Primo PNX JSON into a clean result shape
  types.ts        # type defs for clean results + internal Primo shapes
```

- `primoClient.ts` hardcodes NEU-specific constants: `vid=01NEU_INST:NUL`,
  `inst=01NEU_INST`, `scope=MyInst_and_CI`, `tab=Everything`.
- `mapper.ts` exists so Claude never sees Primo's raw nested PNX JSON —
  it gets a clean, flat object per result: title, authors, type, date,
  publisher, identifiers (ISBN/ISSN/DOI), snippet/abstract, availability,
  full-text link (if any), and a link to the OneSearch catalog record page.

## Tools exposed

### `search_onesearch`

Free-text search with common filters.

| param | type | notes |
|---|---|---|
| `query` | string, required | search text |
| `limit` | number, optional | default 10, capped at 50 |
| `resourceType` | string, optional | maps to Primo's `rtype` facet (e.g. article, book, journal) |
| `dateFrom` / `dateTo` | number (year), optional | maps to Primo's creation-date facet range |
| `peerReviewedOnly` | boolean, optional | maps to Primo's peer-review facet |
| `sort` | enum, optional | `rank` (default), `date`, `title`, `author` |

Returns: total result count + array of mapped result objects.

### `get_record`

Fetch full detail for one result Claude wants to dig into after searching.

| param | type | notes |
|---|---|---|
| `recordId` | string, required | Primo record id from a prior search result |

Returns: full mapped record — abstract, table of contents (if present),
availability/full-text links.

## Error handling

- HTTP failures, timeouts, and non-200 responses are caught and returned to
  Claude as a clear error message tool result — never an unhandled crash.
- Response parsing is defensive (missing fields default to `undefined`/empty
  rather than throwing), since the endpoint is unofficial and could change.
- Empty result sets return a normal "0 results" response, not an error.

## Testing

- Unit tests (vitest) for query-building (`primoClient.ts`) and JSON-mapping
  (`mapper.ts`) against saved fixture responses (captured from real queries
  during design research) — no network access needed, run in CI.
- One lightweight live smoke test against the real endpoint, run manually /
  optionally rather than in default CI, since it depends on an external,
  unofficial service that could change without notice.

## Out of scope (for this spec)

- NU SSO / OAuth login and personalized account features (loans, holds,
  saved lists, personal full-text entitlements). NEU's Primo VE uses SAML SSO
  (`authentication-system: SAML`, profile `VEsamlprod`, silent login
  disabled) — an interactive browser login flow, not something a background
  MCP process can authenticate as itself. Adding it later would mean
  launching a real browser for the user to log in through and capturing the
  resulting Alma session cookie, which is real added complexity — treat as a
  separate follow-on project, not a small addition to this one.
- Publishing to npm for other users (may revisit later).
- Any UI beyond the MCP tool interface itself.

## Addendum (2026-07-22): campus scope selection

NEU's Primo VE view config (`primaws/rest/pub/configuration/vid/01NEU_INST:NUL`)
exposes four campus-scoped views under `primo-view.available-tabs` /
`pc-availability-tab-scopes-map`, each a distinct `tab`/`scope` pair, verified
live to return distinct result counts:

| Campus | tab | scope |
|---|---|---|
| All Campuses | `Everything` | `CDI_plus_all_local` |
| Boston Campus | `Boston` | `MyInst_and_CI` |
| Oakland Campus | `Oakland` | `Mills_and_CI` |
| Online Only | `Online` | `CDI_and_EResources` |

**Bug found:** the server has hardcoded `tab=Everything` + `scope=MyInst_and_CI`
since Task 3 — that's the *Boston* scope value paired with the "Everything"
tab label, not genuine all-campus results. This addendum fixes it.

`search_onesearch` gains an optional `campus` param (`'all' | 'boston' |
'oakland' | 'online'`, default `'all'`) that selects the correct pair.
`get_record` always uses the `all` pair (`CDI_plus_all_local`/`Everything`)
regardless — it's an exact record-id lookup, not a campus-scoped browse, so
maximizing lookup success matters more than matching a UI tab.
