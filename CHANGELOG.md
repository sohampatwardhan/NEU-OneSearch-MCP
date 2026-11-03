# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `get_full_text` and `get_record` accept `cdi_` Central Discovery Index record ids as well as `alma` ids (#12). For `cdi_` records without a DOI, full-text links from `pnx.links` are used (#20).
- `search_onesearch` filters (`resourceType`, date range, `peerReviewedOnly`) combine (AND) in one call (#13).
- `get_full_text` results carry `fullText`, `readUrl`, `textKind` and `version`, so an agent can tell the user plainly when full text was not retrieved and link them to `readUrl` (#17).
- New `blocked` status for bot checks, challenges, CAPTCHA pages, EZproxy interstitials and cookie-less 403s. The server never solves or bypasses checks (#16).
- Open-access fallback via OpenAlex for blocked, not proxied, not entitled, login-required (no session needed) and abstract-only results, with `version` reporting which copy was used (#18).
- Overall 60-second deadline per `get_full_text` call; a timeout or a failed download still returns a result with `readUrl`. The OneSearch record lookup is capped at 20 seconds.
- Bundled agent skill `neu-literature-review` (`skills/neu-literature-review/SKILL.md`, also shipped in the npm package). Install with `npx skills add sohampatwardhan/NEU-OneSearch-MCP --skill neu-literature-review` (#21).

### Fixed

- Elsevier `linkinghub` redirects are followed, and abstract-only ScienceDirect pages are reported as `partial` with `textKind` `abstract` (#15).
- Real Wiley article pages were misread as bot walls (false positive in `looksLikeBotWall`) (#14). Challenge phrases in a page's text now count only on short pages, and only as whole words, so an article opening with "Client challenges…" is not misread.
- Bot walls are reported as `blocked` instead of `unsupported` (#16).

## [0.3.0] - 2026-11-03

### Added

- Open-access full text for publishers that are not on NEU's EZproxy.
  `get_full_text` fetches the publisher page and its `citation_pdf_url`
  directly, without session cookies. If that fails, a new `not_proxied` status
  returns the publisher URL in `sourceUrl`. Each direct hop must be http(s) and
  resolve only to globally routable addresses. The check runs again in the
  socket's DNS lookup, so a DNS rebind between check and connect cannot reach a
  private address. IPv6 forms that embed IPv4 (6to4, Teredo, NAT64,
  IPv4-compatible) are refused.
- The SSRF host guard also blocks carrier-grade NAT (`100.64.0.0/10`, used by
  VPN overlays such as Tailscale) and multicast or reserved addresses.

### Fixed

- `get_full_text` returned `login_required` for publishers NEU's EZproxy does
  not proxy. EZproxy passes those through to the publisher (for example
  `doi-org.ezproxy.neu.edu` -> `dx.plos.org` for PLOS), and any redirect off the
  proxy was treated as a sign-in bounce. Now only a redirect to an NEU sign-in
  host (`neuidmsso.neu.edu`, Shibboleth, Duo) means `login_required`. Session
  cookies are still never sent off the proxy.
- Microsoft Entra sign-in hosts (`login.microsoftonline.com`,
  `login.microsoft.com`, `login.windows.net`) now count as NEU sign-in. NEU's
  1Login program is moving apps, including EZproxy and Primo VE, from
  Shibboleth to Microsoft. Without this, an expired session bouncing to
  Microsoft would be read as an unproxied publisher instead of `login_required`.

## [0.2.1] - 2026-11-02

### Fixed

- `get_full_text` returned `login_required` even with a valid EZproxy session.
  Proxied links put a percent-encoded target in `login?url=`, which NEU's
  EZproxy does not honor, so it showed its database menu instead of the
  article. Links now use `login?qurl=`, the parameter EZproxy reads encoded, so
  the target's own query string also survives. The login probe uses the same
  builder. ([#8](https://github.com/sohampatwardhan/NEU-OneSearch-MCP/issues/8))
- A landing on EZproxy's `/menu` page is reported as an `error` saying the
  proxy did not accept the target, instead of telling the user to sign in
  again.

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
