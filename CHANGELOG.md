# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-02

### Added

- `get_full_text` tool: fetches full text for a OneSearch record through
  Northeastern EZproxy using the cached session, extracting text from HTML and
  PDF (`pdfjs-dist`, eval disabled) with size, page and character caps. Returns
  a structured status (`ok`, `login_required`, `not_entitled`, `unsupported`,
  `too_large`) and only fetches allow-listed hosts.
- Browser SSO sign-in through a dedicated, persistent Playwright Chrome
  profile (`channel: chrome`), so the NEU IdP session and Duo "remember this
  device" survive between runs and re-login is usually one click. Captured
  OneSearch and EZproxy cookies plus the capture time are cached owner-only
  under `~/.cache/neu-onesearch-mcp/` (`0700` dir, `0600` file). No password
  is ever stored, and cookie values are never printed. `NEU_ONESEARCH_CACHE_DIR`
  moves the cache (path only). Session lifetime is treated as short for v1
  (about one hour, to verify).
- `neu-onesearch-logout` (`dist/logout.js`) deletes the cached session and the
  browser profile. Idempotent.
- A `login_required` result: when a cached session is attached and NEU bounces
  to sign in or rejects the cookie (301/302 to an SSO host, or 401/403), tools
  return `{"status":"login_required"}` with guidance to run login again,
  instead of failing silently. Anonymous (no-session) behavior is unchanged.
- Published to npm as `@sohampatwardhan/neu-onesearch-mcp`, runnable with
  `npx -y @sohampatwardhan/neu-onesearch-mcp@latest`. A second bin,
  `neu-onesearch-login`, runs the optional NEU login.
- CI workflow (typecheck, build, tests, pack check) and a tag-triggered
  release workflow that publishes to npm via trusted publishing with
  provenance and mirrors the release to GitHub Packages.

- `doiUrl` field on every mapped result (`https://doi.org/<doi>`, `null` if
  no DOI present). Unlike `catalogUrl`, which points at the OneSearch
  discovery record and can show a sign-in wall for CDI-sourced records when
  opened outside an active OneSearch browser session, `doiUrl` always
  resolves without needing an NEU login.
- `ezproxyDoiUrl` field on every mapped result (`https://doi-org.ezproxy.neu.edu/<doi>`,
  `null` if no DOI present). Routes the DOI through NEU's EZproxy, prompting
  a real NEU sign-in and then forwarding through the library's subscriptions
  for authenticated full-text access — the counterpart to `doiUrl` for NEU
  users who want entitled access rather than just the public landing page.

### Changed

- Corrected the README's claim that logging in "may improve full-text/
  entitlement access." Live testing (a real login, verified against three
  catalog items including one with a full-text proxy link) found no
  observable difference in `search_onesearch`/`get_record` results between a
  valid session, an invalidated session, and no session at all. Login exists
  as groundwork for future patron-identity features, not because it changes
  today's search results.
- The server reports its version from `package.json` instead of a
  hard-coded `0.1.0`.

### Fixed

- The server now starts when launched through a symlink (the
  `node_modules/.bin` shim that `npx` and global installs use). The old
  entrypoint check compared `import.meta.url` with the raw `argv[1]` path, so
  a symlinked launch exited immediately without serving.

## [0.1.0] - 2026-07-22

### Added

- Initial MCP server for Northeastern University's Scholar OneSearch (Primo
  VE), exposing `search_onesearch` and `get_record` tools over stdio — no
  API key or login required, using NEU's own internal search endpoint.
- `campus` parameter on `search_onesearch` to restrict results to All
  Campuses, Boston Campus, Oakland Campus, or Online Only.
- Optional NEU SAML login (`node dist/login.js`): drives a real browser
  through NEU's actual SSO/Duo login flow and captures the resulting
  session, which `search_onesearch`/`get_record` then attach automatically
  for improved full-text/entitlement access. Fully additive — with no
  session, behavior is unchanged.
- Manual live smoke test script (`scripts/smoke-test.mjs`) for verifying the
  (unofficial) OneSearch endpoint still behaves as expected.

### Fixed

- Corrected a mislabeled default search scope that was actually restricting
  every search to Boston + central index rather than genuine all-campus
  results.
- Corrected the same scope mislabeling in generated catalog permalink URLs,
  and made them reflect whichever campus was actually searched.
- Closed a TOCTOU race where the session file briefly existed with
  broader-than-intended permissions before being restricted to owner-only.
- Scoped session cookies to the OneSearch domain only, fixing a cookie-name
  collision between NEU's SSO domain and the OneSearch API domain that
  could otherwise have sent the wrong session.
- Anchored the session-domain filter to reject look-alike domains (e.g. a
  suffix-superstring like `evilonesearch.library.northeastern.edu`).

### Changed

- Login now launches the user's actual installed Google Chrome rather than
  Playwright's bundled testing build.
