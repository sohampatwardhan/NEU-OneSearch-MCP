# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `get_full_text(doi?, recordId?)` downloads one entitled item through NEU
  EZproxy and returns extracted plain text (PDF text layer or HTML), plus
  source URL, content type, and page count. It requires an EZproxy cookie
  from `node dist/login.js`. Login now continues into the library proxy
  after OneSearch SSO so that cookie is captured. The password is still
  entered only in the browser.
- Caps and explicit statuses for the cases that are not full text:
  `login_required`, `not_entitled`, `partial`, `unsupported` (CAPTCHA,
  scanned/encrypted PDF, non-HTML binary), `too_large` (20 MB), and
  truncation at 40 PDF pages / 100,000 characters. The download cap is
  20 MiB (20,971,520 bytes).
- `NEU_ONESEARCH_SESSION_PATH` to move the session file. No env var accepts
  a password or a raw cookie.
- `scripts/fulltext-smoke.mjs` for a manual signed-in check. It is not part
  of `npm test` and does not embed a session.

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

- `node dist/login.js` opens EZproxy after OneSearch sign-in and reports
  whether an EZproxy cookie was saved.
- Corrected the README's claim that logging in "may improve full-text/
  entitlement access." Live testing (a real login, verified against three
  catalog items including one with a full-text proxy link) found no
  observable difference in `search_onesearch`/`get_record` results between a
  valid session, an invalidated session, and no session at all. That is
  still true for those two tools. Entitled article text is `get_full_text`,
  which uses the EZproxy cookie rather than the OneSearch session.

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
