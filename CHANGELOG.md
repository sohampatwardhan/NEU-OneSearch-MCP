# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
