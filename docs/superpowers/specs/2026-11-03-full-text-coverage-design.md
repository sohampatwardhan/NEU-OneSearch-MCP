# Full-Text Coverage and Combined Search Filters — Design

Covers [#11](https://github.com/sohampatwardhan/NEU-OneSearch-MCP/issues/11) and
[#12](https://github.com/sohampatwardhan/NEU-OneSearch-MCP/issues/12). Baseline is 0.3.0.

## Intent

This server exists to help with literature reviews. An agent working for a student or
academic searches OneSearch, takes the hits, reads them, and helps the person synthesize
them. Getting some bytes back isn't enough: the agent has to be able to read the paper,
or get an honest, specific reason it can't.

Two real clients hit the same wall on 0.3.0: the owner's Claude Code session researching
an actual course report (TELE 7945), and Grok Bot running the server on a separate machine.
Both could search but got almost no readable full text. Three things are wrong:

1. **Search:** agents naturally combine filters (peer-reviewed + a date range + articles),
   and the server rejects any combination.
2. **Search result to full text:** most results are `cdi_` (Central Discovery Index) records,
   and `get_full_text` rejects them with an error that blames `get_record`.
3. **Fetching:** several publishers fail, and some failures are mislabeled. Junk is
   reported as `partial` text, and a real article is reported as a bot wall.

The owner usually works **off campus**, so anything that only works from a NEU network
address is out for now.

## Goals

- `search_onesearch` accepts any combination of `resourceType`, a date range, and
  `peerReviewedOnly`.
- `get_full_text` and `get_record` accept `cdi_` record IDs, not just `alma` ones.
- No bot-check, challenge, or block page is ever returned as `ok` or `partial` text.
- A real article page is never reported as a bot wall.
- Elsevier and Wiley articles that NEU subscribes to come back as readable text through
  EZproxy.
- When the publisher blocks automated access, the agent gets a result it can act on: a link
  ready to open in a browser, and, when one exists, a free open-access copy.
- **Whenever the text can't be fetched, the user still gets a link they can click** to read
  the paper in their own browser (owner's requirement). This applies to every status, not
  just `blocked`.
- Every result says which version of the paper the text came from when it isn't the
  publisher's version (a literature review needs to know).

## Non-goals

- New publisher-specific scraping beyond what's described here.
- Official publisher text-mining APIs (see Deferred).
- Returning or saving the PDF file itself (see Deferred).
- Changes to sign-in, session handling, or EZproxy link building.

## Anti-goals (a failure even if it "works")

- **Getting around bot checks.** No fake browser headers to dodge a challenge, no solving
  or skipping CAPTCHAs or JavaScript challenges, no retrying with different fingerprints
  after a block. A block is reported, not defeated. (During research the permission system
  stopped a probe that sent made-up browser headers to IEEE, and that was right.) This
  rules out two of #11's suggestions: a browser `User-Agent` for MDPI's 403, and working
  around Springer's challenge page.
- **Junk presented as the paper.** If the text isn't the article, the status must not be
  `ok` or `partial`.
- **Session cookies sent off the proxy.** This rule from 0.3.0 stays.

## What live testing found (2026-11-03, with a real NEU session)

These findings ground the design. Re-check anything that has drifted before relying on it.

| Area | Finding |
| --- | --- |
| Combined filters | `qInclude` with clauses joined by `\|,\|` (e.g. `facet_tlevel,include,peer_reviewed\|,\|facet_searchcreationdate,include,[2020 TO 2026]`) returns HTTP 200 and **ANDs** the clauses. On one query: none 1,813, peer-reviewed 1,288, 2020–26 1,539, articles 1,275, peer-reviewed + 2020–26 1,173, all three 1,115. Books + 2022–23 gave 1 result, all in range; peer-reviewed + books gave 0. `multiFacets` behaves the same, but `qInclude` is what the code already uses. |
| `cdi_` lookup | `GET /primaws/rest/pub/pnxs/CDI/<cdi id>?inst=01NEU_INST&lang=en&vid=01NEU_INST:NUL&search_scope=CDI_plus_all_local&adaptor=Primo%20Central` returns the full PNX for that record, DOI included. A search with `q=rid,exact,<id>` also works. |
| `cdi_` without DOI | These exist (Gale, ProQuest in a general-topic sample). Their full-text links live in `pnx.links` as `$$U<url>$$E…`-encoded strings: `linktopdf`, `linktohtml`, `linktorsrc`. The current mapper only reads `delivery.link` entries with `linkType === 'linktorsrc'`, so it misses these. |
| Search mix | Topic searches returned roughly half `cdi_` records. In a computing-topic sample, every `cdi_` record had a DOI. |
| ACM | Already `ok` in 0.3.0 (PDF through the proxy). |
| Wiley | 0.3.0 says `unsupported` ("bot check") for `10.1002/ett.4150`, but the proxied page is the real article (818 KB, 127,298 characters of text). Cloudflare's passive `cdn-cgi/challenge-platform` script is on normal pages, and `looksLikeBotWall` treats that marker alone as a wall. **False positive.** |
| Elsevier | 0.3.0 returns `partial` with the text "Redirecting" (11 characters). `linkinghub.elsevier.com` answers with an HTML page whose `redirectURL` form field holds the ScienceDirect URL. Following it through the proxy reaches `www.sciencedirect.com/science/article/pii/<PII>` (HTTP 200, about 199 KB). That page yielded about 5,300 characters, which **may be only the abstract and metadata**. The ScienceDirect page also contains the Cloudflare marker. |
| Springer | Article page: a "Client Challenge" bot check (0.3.0 reports `partial`, 230 characters). The `content/pdf/<doi>.pdf` link (Springer's official text-mining link in Crossref) stops at an EZproxy page that says "To access this document, wait a moment or click here to continue." This wasn't followed. |
| IEEE | Article page: HTTP 202 with a JavaScript "verify that you're not a robot" page. `stampPDF/getPDF.jsp` and `stamp/stamp.jsp` return 502. The issue's assumption that the PDF is reachable without JS is wrong. |
| MDPI | Not on the proxy. A plain request to `/pdf` returns 403 (404-byte HTML). Europe PMC has neither test paper. |
| OpenAlex | `GET https://api.openalex.org/works/doi:<doi>` is free, keyless, and lists open-access locations with `pdf_url` and `version` (`submittedVersion`, `acceptedVersion`, `publishedVersion`). For Springer `10.1007/s10462-024-10827-x` (blocked at Springer), a White Rose repository PDF (submitted version, 2 MB) downloaded fine with an honest user agent. For MDPI the only `pdf_url` is MDPI's own (blocked). IEEE's test papers are closed, with no copies anywhere. |
| Official APIs | Elsevier's Article Retrieval API and Wiley's TDM API give full text only when the request comes from a subscribing institution's IP ("Access is IP address based only" for Wiley). Springer Nature's full-text API is on its paid plans page. IEEE's full-text API is "chargeable" through sales. MDPI has none. |

## Design

### 1. Combined search filters (#11 item 1)

- `buildFacetClause` builds one clause per filter that's present and joins them with `|,|`
  into `qInclude`. The order doesn't matter, but keep it stable for tests. Drop the
  "only supports one filter" error.
- Update the `search_onesearch` tool and parameter descriptions so agents know the filters
  combine (AND).
- Existing tests that expect the error change to expect the joined clause.

### 2. `cdi_` records in `get_full_text` and `get_record` (#12)

- `getRecord(recordId)`:
  - `alma…` IDs use the existing `mms_id` search.
  - `cdi_…` IDs use the `pnxs/CDI/<id>` endpoint above. If it ever fails, the builder may
    fall back to the `rid,exact,<id>` search, which was also verified.
  - Any other prefix is rejected with a message that lists both supported prefixes.
- `get_record` gets `cdi_` support for free. Its description and the `recordId` parameter
  descriptions say so.
- **Full-text links for records without a DOI.** The mapper also reads `pnx.links`
  (`linktopdf`, then `linktohtml`, then `linktorsrc`), decoding the `$$U<url>` part. Each
  link goes through the existing `toEzproxyFetchUrl` (and its SSRF guard) like any other
  candidate. Today's `delivery.link` source stays.
- **Order inside `targetFromMapped` stays:** DOI first, then a full-text link. If there's
  neither, the result is `unsupported` with "This record has no DOI or full-text link to
  retrieve."
- **Errors name the caller's tool.** A `get_full_text` failure never says "get_record only
  supports…". The record-lookup error text is neutral, or each tool wraps it.

### 3. Fetch fixes

**3a. Bot-wall detection without false positives (Wiley).** `looksLikeBotWall` no longer
treats the Cloudflare script marker alone as a wall:
- A challenge marker counts only when the extracted text is short.
- Strong challenge phrases ("Client Challenge", "verify that you're not a robot", "Just a
  moment", "Enable JavaScript and cookies to continue", "Attention Required! | Cloudflare")
  count regardless of length.

Calibrate the length threshold against the recorded pages: Wiley's real page has 127,298
characters and Springer's challenge page 230. Keep the fixtures as test cases.

**3b. Follow Elsevier's redirect page.** When an HTML response is the linkinghub
`redirectURL` page, follow that URL through the proxy as one more hop, keeping the same
redirect and SSRF limits. Then:
- **If the ScienceDirect page is only an abstract** (the builder decides how to tell, for
  example through text length, meta tags, or a missing body section), look for a PDF link
  (`citation_pdf_url` or the page's own PDF link) and try that through the proxy, as
  0.3.0 already does for `citation_pdf_url`.
- **If that is blocked,** the result is `blocked` (see 3c), not `partial`.
- **Confirm live which case ScienceDirect falls into** before building the abstract
  detector. Stop if a step meets a challenge.

**3c. A new `blocked` status.** It's added to `FullTextStatus` and the tool description.
- **When it's used:** a bot check, challenge or CAPTCHA page (Springer, IEEE), or a 403 from
  a direct off-proxy fetch of a publisher we know is open access (MDPI). An EZproxy
  interstitial ("wait a moment or click here to continue") counts as blocked too. It isn't
  followed.
- **What the result contains:**
  - `text: null`.
  - `sourceUrl`: the best link for a person to open in a browser. Use the EZproxy link when
    the publisher is proxied, otherwise the publisher URL.
  - A message saying that the publisher blocked automated access, which isn't a sign of
    missing access; that an agent with a browser can open `sourceUrl` and let the person
    sign in or pass any check there; and that this server doesn't solve CAPTCHAs.
- **403 wording:** a 403 on a direct fetch no longer suggests the paper might be paywalled.
- **When to try open access:** `blocked` is a final status only after the open-access
  fallback (3d) has been tried and found nothing.

**3d. Open-access fallback through OpenAlex.** When the main route ends `blocked` or
`not_proxied` and the target has a DOI:
- **Lookup:** call `api.openalex.org/works/doi:<doi>` (keyless).
- **Which copy to try:** try `pdf_url` locations in order. Prefer `publishedVersion`, then
  `acceptedVersion`, then `submittedVersion`. Skip the host that just blocked us.
- **How to fetch:** never send cookies; use the existing direct-fetch guards (public
  addresses only, redirect cap, size cap); stop at the first PDF that extracts text.
- **On success:** the result is `ok`, `sourceUrl` is the copy's URL, and a new field,
  `version`, holds `published`, `accepted` or `submitted` (`null` when not from OpenAlex,
  i.e. the publisher's version). The message names the repository and says when the text
  is not the published version.
- **On failure:** if nothing works, keep the original `blocked` or `not_proxied` result and
  add one line saying no open-access copy was found.
- **OpenAlex problems:** if OpenAlex errors or times out, skip the fallback quietly and say
  so in the message. It is never the reason a call fails.

**3e. A clickable link on every result without text.**
- **Which results:** every `get_full_text` result whose `text` is `null` carries a
  `readUrl`, a link a person can click to read the paper in their own browser, unless the
  input had no usable target at all (an invalid DOI, or a record with neither DOI nor link).
- **What it points to:** the EZproxy link for proxied publishers (it works in a browser
  where the person is signed in, including for `login_required` and `not_entitled`); the
  publisher or `doi.org` URL for publishers not on the proxy; the open-access copy when one
  was found but couldn't be extracted.
- **Separate from `sourceUrl`:** `sourceUrl` keeps its current meaning (where the server
  fetched from), because the two can differ.
- **Tool description:** tell the agent to show `readUrl` to the user as a clickable link
  whenever the text isn't returned.
- **Messages:** each status's message ends by pointing to it.

**3f. An honest User-Agent.** Replace the Chrome string in `src/ezproxy.ts`:
- **New value:** something that names the tool, version and repo URL, e.g.
  `neu-onesearch-mcp/<version> (+https://github.com/sohampatwardhan/NEU-OneSearch-MCP)`.
- **Check first:** confirm live that EZproxy sign-in, Nature, ACM, Wiley and Elsevier still
  work with it.
- **If the new UA breaks a publisher that worked before:** stop and report back rather than
  reverting to the Chrome string. That decision goes back to the owner.
- **OpenAlex:** add `mailto=` only if the owner opts in. Don't add the owner's email
  automatically.

## Status outcomes after this change (expected)

| Publisher | Expected result |
| --- | --- |
| ACM | `ok` (unchanged) |
| Wiley (subscribed or OA) | `ok` through the proxy |
| Elsevier (subscribed) | `ok` if the ScienceDirect page or PDF has the body; otherwise `blocked` with the proxied link |
| Springer | `ok` from an open-access copy when one exists (with `version`), otherwise `blocked` with the proxied link |
| IEEE | `blocked` with the proxied link (no copies found for the test papers) |
| MDPI | `ok` from an open-access copy when one exists, otherwise `blocked` with the MDPI link |
| PLOS and other OA not on the proxy | `ok` (unchanged from 0.3.0) |

## Testing

- **Unit tests** cover each piece above:
  - Joined facet clauses (all combinations).
  - The `cdi_` lookup URL.
  - `$$U` link decoding.
  - The error wording.
  - The bot-wall classifier on recorded snippets of the Wiley and Springer pages.
  - The Elsevier redirect hop.
  - `blocked` results.
  - The OpenAlex fallback order and `version` field, with a mocked OpenAlex response.
  - OpenAlex failure being non-fatal.
  - `readUrl` present on every status that has no text (except the no-target cases).
  - No cookies on any off-proxy request.
- **Record tests** for `cdi_` with a DOI, `cdi_` without a DOI but with `linktopdf`, `cdi_`
  with neither, and `alma` (as #12 asks).
- **Live check before release** (manual, with a session), using the same DOIs as this
  research:

  | Publisher | DOIs |
  | --- | --- |
  | Springer | `10.1007/s42979-024-03476-y`, `10.1007/s10462-024-10827-x` |
  | IEEE | `10.1109/TII.2018.2822680`, `10.1109/TASE.2021.3073396` |
  | MDPI | `10.3390/cryptography7020030`, `10.3390/electronics13071391` |
  | Elsevier | `10.1016/j.cose.2025.104509`, `10.1016/j.neucom.2023.127068` |
  | ACM | `10.1145/3453155`, `10.1145/3582571` |
  | Wiley | `10.1002/ett.4150` |

  Plus the multi-filter search from #11 and the `cdi_` record from #12
  (`cdi_crossref_primary_10_34028_iajit_19_2_8`). If any probe meets a challenge page,
  record it and stop. Don't try variations to get past it.

## Deferred (recorded, not dropped)

- **Official publisher APIs** (Elsevier Article Retrieval, Wiley TDM, Springer Nature
  full-text). They need a NEU network address (on campus or VPN). The owner works mostly
  off campus, and Grok Bot runs elsewhere. Worth revisiting if NEU's IP rules or the
  owner's setup change, or if Elsevier's institution token turns out to be available to
  NEU.
- **Returning the PDF file** (saving it and handing back a path) for cases where text
  extraction fails. Not needed while text extraction works.
- **Unpaywall** as a second open-access source. It needs a contact email on every call.
  OpenAlex covers the same data without one.
- **Primo `multiFacets`** as an alternative to `qInclude`. Same behavior; not needed.
- **Grok Bot's stale tool list** (it showed only the two original tools while
  `get_full_text` worked). Most likely client-side caching. Look into it only if it comes
  up again.

## Left to the builder

- Exact text-length thresholds and challenge phrase list (calibrated on the recorded pages).
- How to detect an abstract-only ScienceDirect page.
- Module structure (e.g. a separate `openAccess.ts`), naming, and message wording within the
  constraints above.
- Whether `version` appears on every result or only on fallback results. It must be `null`
  or absent when the text is the publisher's version.
- The version bump and CHANGELOG at release (`blocked` and `version` are additions, so a
  minor bump).
