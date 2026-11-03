# Full-Text Coverage and Combined Search Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent doing a literature review can combine search filters, get full text for `cdi_` results, and get either readable text, an abstract it can triage, or a plain "full text was not retrieved" with a link the user can click. A bundled `neu-literature-review` skill teaches agents that workflow.

**Architecture:**
- **Search and records:** `primoClient.ts` learns combined facets and `cdi_` lookups; `mapper.ts` learns `pnx.links`.
- **Full text:** `fullText.ts` stays the orchestrator. A new `fullTextResult.ts` owns the result shape and one `finalizeResult` step that every return path goes through. A new `openAccess.ts` owns the OpenAlex fallback, and a new `deadline.ts` owns the overall time budget.
- **Classification:** detection of bot walls, interstitials, Elsevier redirects and abstract-only pages lives in `extractText.ts` and `ezproxy.ts`, next to the existing detectors.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), `@modelcontextprotocol/sdk`, `zod`, `vitest`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-03-full-text-coverage-design.md`. Read it, especially "Decisions from the builder review", which overrides earlier sections where they differ.

**Issues:** #11, #12, sub-issues #13–#20. Reference the issue each task closes in its commit message.

## Global Constraints

- **Branch:** work on `feat/11-12-full-text-coverage`, rebased on `main`. The task commits land through one PR to `main`. Don't push to `main`.
- **Each commit:** `npm run typecheck` and the full test suite (`npx vitest run`) pass before it.
- **Never send session cookies to a host outside `*.ezproxy.neu.edu`.** OpenAlex and open-access copies are always fetched without cookies via `fetchPublicResource`.
- **No bot-check circumvention:**
  - no browser-imitating headers added to get past a block
  - no retrying a blocked URL with different headers
  - no solving, skipping or auto-following a challenge or an EZproxy "wait a moment … click here to continue" page

  A block is classified and reported.
- **Fixtures:** no article text in committed fixtures. Challenge and interstitial pages may be committed trimmed. "Real article" fixtures are synthetic.
- **New statuses and fields:**

  | Name | Exact values |
  | --- | --- |
  | `FullTextStatus` | `'ok' \| 'partial' \| 'login_required' \| 'not_proxied' \| 'not_entitled' \| 'not_found' \| 'too_large' \| 'unsupported' \| 'blocked' \| 'error'` |
  | `TextKind` | `'article' \| 'abstract' \| 'unknown'` |
  | `CopyVersion` | `'published' \| 'accepted' \| 'submitted' \| 'unknown'` |

- **Message prefixes** (decision 10):
  - When `fullText` is `false`, the message starts with `Full text was not retrieved: `.
  - Abstract-only results start with `Abstract only. Full text was not retrieved: `.
- **OpenAlex:**
  - The lookup is `https://api.openalex.org/works/doi:<encodeURIComponent(doi)>`, with no key and no `mailto` (decision 7, 3f).
  - Try at most **3** copies, in version order published, accepted, submitted, unknown.
  - Skip the fallback when less than **10,000 ms** of the deadline is left.
- **Overall deadline:** `get_full_text` gets **60,000 ms**. A timeout still returns a result with `readUrl`.
- **User-Agent:** don't change the existing value until Task 11.

## Review Focus

1. **DOIs with characters that break URLs**, like `10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0`. The OpenAlex lookup must percent-encode the DOI and still match. The test is in Task 9.
2. **An OpenAlex `pdf_url` that points to a private address, `http:` loopback, or redirects there.** It must be refused by the existing public-only guard, and the next copy tried. The test is in Task 9.
3. **An OpenAlex `pdf_url` that returns an HTML landing page instead of a PDF.** That must not count as the article. Skip it and try the next copy. The test is in Task 9.
4. **A `cdi_` ID containing characters that are special in a URL path** (`/`, `#`, `?`, spaces). It must be percent-encoded in the `pnxs/CDI/<id>` path. The test is in Task 2.
5. **A `pnx.links` entry whose `$$U` value is relative, `javascript:`, or missing.** Ignore it and fall through to the next link or the DOI, never crash. The test is in Task 3.

---

### Task 1: Combine search filters (#13)

**Files:**
- Modify: `src/primoClient.ts` (`buildFacetClause`)
- Modify: `src/index.ts` (`search_onesearch` filter descriptions)
- Modify: `README.md` (Tools: remove the one-filter sentence and say the filters combine)
- Modify: `vitest.config.ts`. Add `exclude: [...configDefaults.exclude, '.claude/**']` so tests in agent worktrees aren't collected.
- Test: `test/primoClient.test.ts`

**Interfaces:**
- Produces: `buildFacetClause(params: SearchOneSearchParams): string`. It returns clauses joined by `|,|` in the fixed order resourceType, date range, peer-reviewed. It returns `''` when there are none, and never throws.

- [ ] **Step 1: Replace the "throws when more than one filter" test with combination tests**

```ts
it('joins all filters with |,| in a fixed order', () => {
  expect(buildFacetClause({ query: 'x', resourceType: 'articles', dateFrom: 2020, dateTo: 2026, peerReviewedOnly: true }))
    .toBe('facet_rtype,include,articles|,|facet_searchcreationdate,include,[2020 TO 2026]|,|facet_tlevel,include,peer_reviewed');
});
it('joins peer-reviewed with an open-ended date range (the #11 query)', () => {
  expect(buildFacetClause({ query: 'x', peerReviewedOnly: true, dateFrom: 2020 }))
    .toBe(`facet_searchcreationdate,include,[2020 TO ${new Date().getFullYear()}]|,|facet_tlevel,include,peer_reviewed`);
});
it('passes the joined clause through buildSearchParams', () => {
  expect(buildSearchParams({ query: 'x', resourceType: 'books', peerReviewedOnly: true }).get('qInclude'))
    .toBe('facet_rtype,include,books|,|facet_tlevel,include,peer_reviewed');
});
```

- [ ] **Step 2: Run `npx vitest run test/primoClient.test.ts`.** Expected: the new tests FAIL with "only supports one filter".
- [ ] **Step 3: Implement.** `buildFacetClause` collects the clauses into an array and joins them with `'|,|'`. The `search_onesearch` descriptions say the filters combine (AND). README updated.
- [ ] **Step 4: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(search): combine resourceType, date range and peer-reviewed filters (#13)`

---

### Task 2: `cdi_` record lookup and tool-neutral errors (#12)

**Files:**
- Modify: `src/primoClient.ts` (`getRecord`)
- Modify: `src/fullText.ts` (`resolveTarget` error wording)
- Modify: `src/index.ts` (`get_record` and `get_full_text` `recordId` descriptions)
- Modify: `README.md` (`get_record` no longer `alma`-only)
- Test: `test/primoClient.test.ts`, `test/fullText.test.ts`

**Interfaces:**
- Produces: `getRecord(recordId: string): Promise<PrimoDoc | null>`.
  - `alma…` IDs keep the `mms_id` search.
  - `cdi_…` IDs call `GET ${BASE_URL}/CDI/${encodeURIComponent(id)}` with params `inst=01NEU_INST`, `lang=en`, `vid=01NEU_INST:NUL`, `search_scope=CDI_plus_all_local`, `adaptor=Primo Central`. The response body is a single `PrimoDoc`, not `{docs}`.
  - Any other prefix throws `Error('Unsupported record id "<id>". Use a recordId from search_onesearch: it starts with "alma" (catalog) or "cdi_" (Central Discovery Index).')`.
  - A 404 returns `null`.
- Note: `fetchPrimo` currently assumes a search response. Add a small `fetchPrimoDoc(url)`, or widen the type. The session-cookie and `LoginRequiredError` handling must stay the same for both.

- [ ] **Step 1: Write the failing tests**

```ts
it('fetches a cdi_ record from pnxs/CDI with the Primo Central adaptor', async () => {
  // stub fetch -> 200 JSON { pnx: { control: { recordid: ['cdi_crossref_primary_10_34028_iajit_19_2_8'] }, addata: { doi: ['10.34028/iajit/19/2/8'] } } }
  const doc = await getRecord('cdi_crossref_primary_10_34028_iajit_19_2_8');
  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.pathname).toBe('/primaws/rest/pub/pnxs/CDI/cdi_crossref_primary_10_34028_iajit_19_2_8');
  expect(url.searchParams.get('adaptor')).toBe('Primo Central');
  expect(doc?.pnx.addata?.doi?.[0]).toBe('10.34028/iajit/19/2/8');
});
it('percent-encodes path-unsafe characters in a cdi_ id', async () => {
  await getRecord('cdi_odd/id#1 ?x');
  expect(fetchMock.mock.calls[0][0]).toContain('/CDI/cdi_odd%2Fid%231%20%3Fx?');
});
it('returns null when the cdi_ record is 404', async () => { /* stub 404 -> expect null */ });
it('rejects other prefixes and names both supported ones', async () => {
  await expect(getRecord('pq_123')).rejects.toThrow(/"alma".*"cdi_"/);
});
```

In `test/fullText.test.ts`:
- Replace `'rejects a non-alma record id the same way get_record does'` with `'resolves a cdi_ recordId to its DOI'`. Global `fetch` serves the CDI doc above, and `fetchImpl` returns a PDF. Expect `result.doi === '10.34028/iajit/19/2/8'` and `status` `'ok'`.
- Add `'never names get_record in a get_full_text error'`: `recordId: 'pq_1'` gives `status` `'error'` and `expect(result.message).not.toMatch(/get_record/)`.

- [ ] **Step 2: Run `npx vitest run test/primoClient.test.ts test/fullText.test.ts`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `getRecord` as specified. `resolveTarget` uses the thrown message as is (it no longer mentions `get_record`). Its "Provide a doi …" message says `"alma" or "cdi_" recordId`. Update the descriptions and README.
- [ ] **Step 4: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(records): accept cdi_ record ids in get_record and get_full_text (#12)`

---

### Task 3: Full-text links from `pnx.links` (#20)

**Files:**
- Modify: `src/types.ts`. Add `links?: { linktopdf?: string[]; linktohtml?: string[]; linktorsrc?: string[] }` to `PrimoDoc['pnx']`.
- Modify: `src/mapper.ts` (`findFullTextUrl`)
- Test: `test/mapper.test.ts`, `test/fullText.test.ts`

**Interfaces:**
- Produces: `parsePrimoLink(raw: string): string | null`, exported from `mapper.ts`. It takes the substring after `$$U` up to the next `$$` (or the end). It returns it only if `new URL(value)` parses with protocol `http:` or `https:`, and `null` otherwise.
- Produces: `findFullTextUrl(doc)` order: `delivery.link` `linktorsrc` (existing), then `pnx.links.linktopdf`, `linktohtml`, `linktorsrc`, using the first value that parses. `MappedResult.fullTextUrl` keeps its name.

- [ ] **Step 1: Write the failing tests**

```ts
it('decodes a $$U link', () => {
  expect(parsePrimoLink('$$Uhttps://www.proquest.com/docview/216114114/fulltextPDF?accountid=12826$$EPDF$$Gproquest'))
    .toBe('https://www.proquest.com/docview/216114114/fulltextPDF?accountid=12826');
});
it.each(['$$U/relative/path$$EPDF', '$$Ujavascript:alert(1)$$E', '$$Topenurl_article', ''])('rejects %j', (raw) => {
  expect(parsePrimoLink(raw)).toBeNull();
});
it('maps linktopdf from pnx.links when there is no delivery link', () => {
  const doc = { pnx: { control: { recordid: ['cdi_proquest_journals_216114114'] },
    links: { linktopdf: ['$$Uhttps://www.proquest.com/docview/216114114/fulltextPDF$$EPDF'] } } };
  expect(mapDoc(doc).fullTextUrl).toBe('https://www.proquest.com/docview/216114114/fulltextPDF');
});
it('skips an unusable linktopdf and falls through to linktorsrc', () => { /* linktopdf: ['$$Ujavascript:x'], linktorsrc: ['$$Uhttps://link.gale.com/apps/doc/A1/GIC$$E…'] -> gale URL */ });
```

In `test/fullText.test.ts`:
- `'cdi_ record without a DOI uses its linktopdf through EZproxy'`: the first `fetchImpl` call URL starts with `https://link.ezproxy.neu.edu/login?qurl=` and contains `proquest`.
- `'cdi_ record with neither DOI nor link is unsupported with a clear message'`: `status` `'unsupported'`, `readUrl` `null`, and the message matches `/no DOI or full-text link/`.

- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(records): use pnx.links full-text links for records without a DOI (#20)`

---

### Task 4: Result model: `fullText`, `readUrl`, `textKind`, `version` (#17, decision 10)

**Files:**
- Create: `src/fullTextResult.ts`
- Modify: `src/fullText.ts`. Move `FullTextStatus`, `FullTextResult`, `emptyResult` and `LIMITS_VIEW` to the new file and re-export them from `fullText.ts` so imports keep working. Every return path of `getFullText` goes through `finalizeResult`.
- Test: `test/fullTextResult.test.ts`, `test/fullText.test.ts`

**Interfaces:**
- Produces (in `fullTextResult.ts`):
  - The `FullTextStatus`, `TextKind` and `CopyVersion` types (Global Constraints).
  - `FullTextResult` = the current fields plus `fullText: boolean`, `readUrl: string | null`, `textKind: TextKind | null` and `version: CopyVersion | null`.
  - `emptyResult(overrides)`. The defaults are `fullText: false`, `readUrl: null`, `textKind: null`, `version: null`.
  - `finalizeResult(result: FullTextResult, readUrl: string | null): FullTextResult`. It is pure and is the only place these rules live:
    1. Set `fullText = status === 'ok'`.
    2. If `status === 'ok'`, set `textKind = 'article'`. If `status === 'partial'` and `textKind` is `null`, set it to `'unknown'`.
    3. If `fullText` is `false`, set `readUrl` from the argument when `result.readUrl` is `null`.
    4. If `fullText` is `false`, prefix the message: `Abstract only. Full text was not retrieved: ` when `textKind === 'abstract'`, otherwise `Full text was not retrieved: `. Never double-prefix.
    5. If `fullText` is `false` and `readUrl` is set, append ` Open it in a browser: <readUrl>`.
- Produces (in `fullText.ts`): `ResolvedTarget` gains `readUrl: string | null`, set to `startUrl` (the `login?qurl=` link for proxied targets). In `fullTextDirect` and `notProxied`, use the publisher URL as `readUrl` for that result.
  - The `resolveTarget` failure paths (no input, bad DOI, unsupported record id, no DOI or link) pass `readUrl` `null`.
  - `login_required` without a session still has a target, so it gets `readUrl = startUrl`.

- [ ] **Step 1: Write `test/fullTextResult.test.ts`.** Cover each rule:

```ts
it('marks ok as full text with textKind article and no prefix', () => {
  const r = finalizeResult(emptyResult({ status: 'ok', message: 'Extracted.', text: 'body' }), 'https://link.ezproxy.neu.edu/login?qurl=x');
  expect(r).toMatchObject({ fullText: true, textKind: 'article', readUrl: null, message: 'Extracted.' });
});
it.each(['partial', 'login_required', 'not_proxied', 'not_entitled', 'not_found', 'too_large', 'unsupported', 'blocked', 'error'] as const)(
  '%s is not full text, carries readUrl and the plain prefix', (status) => {
    const r = finalizeResult(emptyResult({ status, message: 'Reason.' }), 'https://link.ezproxy.neu.edu/login?qurl=x');
    expect(r.fullText).toBe(false);
    expect(r.readUrl).toBe('https://link.ezproxy.neu.edu/login?qurl=x');
    expect(r.message.startsWith('Full text was not retrieved: Reason.')).toBe(true);
    expect(r.message).toContain('Open it in a browser: https://link.ezproxy.neu.edu/login?qurl=x');
  });
it('uses the abstract prefix for textKind abstract', () => { /* partial + textKind 'abstract' -> startsWith('Abstract only. Full text was not retrieved: ') */ });
it('defaults partial textKind to unknown', () => { /* ... */ });
it('keeps a readUrl already on the result over the argument', () => { /* not_proxied with readUrl publisher URL */ });
it('is idempotent', () => { /* finalize twice -> same message */ });
```

In `test/fullText.test.ts`, add `'every no-text status carries readUrl except no-target errors'`. Drive the real paths already in the suite (no session, 403, 404, too_large, off-proxy refusal, unsupported content type, EZproxy menu) and assert `readUrl` is non-null and `fullText` is `false`. Separately, the bad-DOI and no-input paths assert `readUrl === null`. Update existing assertions whose message checks now need the prefix.
- [ ] **Step 2: Run the tests.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement** as specified. No behavior change beyond the new fields and message prefixes.
- [ ] **Step 4: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(fulltext): add fullText, readUrl, textKind and version to every result (#17)`

---

### Task 5: Bot-wall classifier without false positives (#14)

**Files:**
- Modify: `src/extractText.ts` (`looksLikeBotWall`)
- Create: `test/fixtures/challenge-springer.html`, `test/fixtures/challenge-ieee.html`, `test/fixtures/mdpi-403.html`, `test/fixtures/ezproxy-interstitial.html` (trimmed live captures), `test/fixtures/synthetic-cloudflare-article.html`
- Create: `scripts/capture-challenge-fixtures.mjs` (one-off, committed for reproducibility)
- Test: `test/extractText.test.ts`

**Interfaces:**
- Produces: `looksLikeBotWall(html: string, text: string): boolean`. It returns `true` when:
  - **(a)** a strong phrase appears in the page `<title>` or the first 1,000 characters of `text`. Strong phrases, case-insensitive, with `'` or `’` accepted for apostrophes: `Client Challenge`, `verify that you're not a robot`, `verify you are (a )?human`, `Just a moment...`, `Enable JavaScript and cookies to continue`, `Attention Required! | Cloudflare`, `please complete the captcha`. Or:
  - **(b)** a weak marker (`cdn-cgi/challenge-platform`, `cf-turnstile`, `g-recaptcha`) appears **and** `text.length < 1500`.

- [ ] **Step 1: Capture fixtures live (needs the cached NEU session).** The script fetches each URL once with the package's existing `fetchEzproxyResource`/`fetchPublicResource`, current headers, and no variations:
  - Springer: `https://doi.org/10.1007/s42979-024-03476-y` through EZproxy.
  - IEEE: `https://doi.org/10.1109/TII.2018.2822680` through EZproxy.
  - MDPI: `https://www.mdpi.com/2410-387X/7/2/30/pdf`, direct.
  - The interstitial: `https://link.springer.com/content/pdf/10.1007/s42979-024-03476-y.pdf` through EZproxy.

  It saves each body trimmed to the first 4 KB, with `<script>` contents replaced by `/* trimmed */`. The `src="…cdn-cgi/challenge-platform…"` attributes are kept, and cookies or tokens in the HTML are stripped. If a capture comes back different from what the spec records (e.g. a real article), stop and report rather than retrying.
  - Write the synthetic article fixture by hand: `<title>Synthetic Article</title>`, a `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js">` tag, and about 3,000 words of generated filler in `<section>`s.
- [ ] **Step 2: Write the failing tests**

```ts
it.each(['challenge-springer.html', 'challenge-ieee.html'])('%s is a bot wall', (f) => {
  const html = fixture(f); expect(looksLikeBotWall(html, htmlToText(html))).toBe(true);
});
it('a real article carrying the Cloudflare script is not a bot wall', () => {
  const html = fixture('synthetic-cloudflare-article.html'); expect(looksLikeBotWall(html, htmlToText(html))).toBe(false);
});
it('a curly apostrophe still matches', () => {
  expect(looksLikeBotWall('<title>x</title><p>We need to verify that you’re not a robot.</p>', 'We need to verify that you’re not a robot.')).toBe(true);
});
it('a strong phrase deep inside a long article does not match', () => { /* 'Just a moment...' after 5,000 chars of text -> false */ });
```

- [ ] **Step 3: Run `npx vitest run test/extractText.test.ts`.** Expected: the synthetic-article test FAILS.
- [ ] **Step 4: Implement** as specified.
- [ ] **Step 5: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 6: Commit** `fix(fulltext): stop treating Cloudflare's passive script as a bot wall (#14)`

---

### Task 6: `blocked` status (#16)

**Files:**
- Modify: `src/ezproxy.ts`. Add `isEzproxyInterstitial`.
- Modify: `src/fullText.ts` (`textFromHtml`, `httpFailure`, `fullTextDirect`, `getFullText`)
- Test: `test/ezproxy.test.ts`, `test/fullText.test.ts`

**Interfaces:**
- Consumes: `looksLikeBotWall` (Task 5) and `finalizeResult` (Task 4).
- Produces: `isEzproxyInterstitial(url: string, html: string): boolean`. It is `true` when the host is `link.ezproxy.neu.edu` or `login.ezproxy.neu.edu` and the HTML contains `wait a moment or click here to continue` (case-insensitive).
- Produces the `blocked` status. Each case below returns `status: 'blocked'`, `text: null`, and a message that says three things: the publisher blocked automated access, which doesn't mean NEU lacks access; an agent with a browser can open the link and the user can finish there; and this server doesn't solve CAPTCHAs.

| Case | Behavior |
| --- | --- |
| A bot wall in `textFromHtml` | Previously `unsupported`. |
| A proxied 401/403 whose HTML body is a bot wall | Checked in `httpFailure` before the `not_entitled` mapping. |
| An EZproxy interstitial | The final URL and HTML match `isEzproxyInterstitial`. Never followed. |
| A 403 in a direct (cookie-less) fetch, in `fullTextDirect` | Decision 1. The message must not mention open access or paywalls. Other direct 4xx responses stay `not_proxied`. |

- [ ] **Step 1: Write the failing tests**
  - `ezproxy.test.ts`: `isEzproxyInterstitial` is true for the fixture on `https://link.ezproxy.neu.edu/login?qurl=…` and false on a publisher host with the same text.
  - `fullText.test.ts`:
    - `'a Springer challenge page is blocked, not partial'`: `fetchImpl` serves `challenge-springer.html` with 200. Expect `status` `'blocked'`, `text` `null`, `readUrl` starting with `https://link.ezproxy.neu.edu/login?qurl=`, and the message matching `/blocked automated access/` and `/browser/`.
    - `'an IEEE challenge served as 403 is blocked, not not_entitled'`.
    - `'the EZproxy interstitial is blocked and its link is not followed'`: assert `fetchImpl` was called once.
    - `'a direct 403 is blocked and does not suggest a paywall'`: off-proxy redirect to `https://www.mdpi.com/…`, then 403 with `mdpi-403.html`. Expect `blocked`, the message not matching `/open access|paywall|subscri/i`, and `readUrl` equal to the MDPI URL.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(fulltext): report bot checks and publisher blocks as blocked (#16)`

---

### Task 7: Elsevier redirect and abstract-only detection (#15, decision 2)

**Files:**
- Modify: `src/extractText.ts`. Add `findLinkingHubRedirect` and `looksLikeAbstractOnly`.
- Modify: `src/fullText.ts`. Follow the redirect as one hop; the abstract check in `textFromHtml`.
- Create: `test/fixtures/elsevier-linkinghub.html` (the redirect page is boilerplate: commit it trimmed).
- Test: `test/extractText.test.ts`, `test/fullText.test.ts`

**Interfaces:**
- Produces: `findLinkingHubRedirect(html: string, pageUrl: string): string | null`.
  - It only applies when the `pageUrl` host is `linkinghub.elsevier.com` or `linkinghub-elsevier-com.ezproxy.neu.edu`.
  - It returns the decoded value of `<input name="redirectURL" value="…">` resolved against `https://www.sciencedirect.com`, or `null`.
- Produces: `looksLikeAbstractOnly(html: string, text: string): boolean`. The rule is decided in Step 1 from live evidence.
- Behavior in `getFullText`:
  - **Redirect hop:** after the first proxied HTML response, if `findLinkingHubRedirect` returns a URL, fetch `toEzproxyFetchUrl(url)` with the response's cookies. That response becomes the page used for the rest of the flow (PDF link, then HTML). The existing redirect cap still holds, so this hop counts toward `maxRedirects`.
  - **Abstract check:** in `textFromHtml`, before the `ok` and short-`partial` branches, if `looksLikeAbstractOnly` returns true, the result is `status: 'partial'`, `textKind: 'abstract'`, with the abstract text. This also covers today's Case 2: a PDF hop that failed and fell back to an abstract page of 2,500 characters or more.

- [ ] **Step 1: Live probe (session required, one request per URL, stop at any challenge).**
  - Fetch `10.1016/j.cose.2025.104509` and `10.1016/j.neucom.2023.127068` through the proxy and follow the redirect once.
  - Record in the task's report:
    - the extracted text length
    - whether `citation_pdf_url` or another PDF link exists, and what fetching it through the proxy returns
    - which markers separate the abstract-only page from a full-text page (e.g. meta `citation_abstract` present with no body section, or a ScienceDirect body container missing)
  - Write `looksLikeAbstractOnly` from that evidence. Commit a synthetic fixture (`elsevier-abstract-only.html`) that reproduces the markers, never the article text.
  - If the ScienceDirect page turns out to carry the full body, still implement the detector for the generic case (a page whose text is mostly a block labelled "Abstract" and under 4,000 characters), and say so in the report.
- [ ] **Step 2: Write the failing tests**
  - `findLinkingHubRedirect` returns `https://www.sciencedirect.com/science/article/pii/S0167404825001981?via%3Dihub` for the fixture, and `null` for the same HTML on a non-linkinghub URL.
  - `fullText.test.ts`, `'follows the Elsevier linkinghub redirect instead of returning "Redirecting"'`:
    1. `fetchImpl` serves the linkinghub fixture first, then a ScienceDirect page that carries the full body.
    2. Expect `status` `'ok'` and `text` not equal to `'Redirecting'`.
    3. The second request URL contains `sciencedirect`.
  - `'an abstract-only page is partial with textKind abstract and the abstract prefix'`.
  - `'a failed PDF hop that lands on an abstract page is not ok'` (Case 2).
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement** as specified.
- [ ] **Step 5: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 6: Commit** `fix(fulltext): follow Elsevier linkinghub redirects and label abstract-only text (#15)`

---

### Task 8: Overall deadline (decision 8)

**Files:**
- Create: `src/deadline.ts`
- Modify: `src/fullText.ts`. Wrap `getFullText`.
- Test: `test/deadline.test.ts`, `test/fullText.test.ts`

**Interfaces:**
- Produces: `interface Deadline { remainingMs(): number; expired(): boolean }` and `createDeadline(totalMs: number, clock: () => number = Date.now): Deadline`.
- Produces: `GetFullTextOptions.deadlineMs?: number` (default `60_000`) and `GetFullTextOptions.clock?: () => number`.
  - Each fetch's `timeoutMs` becomes `min(timeoutMs ?? 20_000, deadline.remainingMs())`.
  - If the deadline expires mid-call, return `finalizeResult` of `status: 'error'` with the message `Timed out after <deadlineMs>ms.`, plus `readUrl` from the target. An outer `Promise.race` against a timer is acceptable. Clear the timer on completion.
- Produces: the deadline is passed to the Task 9 fallback as `deadline: Deadline`.

- [ ] **Step 1: Write the failing tests.**
  - `createDeadline` arithmetic with a fake clock.
  - `'a call that outlives the deadline still returns readUrl'`: `fetchImpl` never resolves and `deadlineMs: 50`. Expect `status` `'error'`, `readUrl` set, and the message matching `/Timed out after 50ms/`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(fulltext): cap get_full_text at an overall 60s deadline`

---

### Task 9: Open-access fallback through OpenAlex (#18, decisions 4–6)

**Files:**
- Create: `src/openAccess.ts`
- Modify: `src/fullText.ts`. Run the fallback after a final result with no usable text.
- Test: `test/openAccess.test.ts`, `test/fullText.test.ts`

**Interfaces:**
- Consumes: `fetchPublicResource` (existing), `extractPdfText`/`textFromPdf` (existing), `Deadline` (Task 8), `finalizeResult` (Task 4).
- Produces (`openAccess.ts`):
  - `interface OaCopy { pdfUrl: string; version: CopyVersion; repository: string | null }`.
  - `findOpenAccessCopies(doi: string, fetchImpl: FetchLike = fetch): Promise<OaCopy[]>`.
    - It calls the URL in Global Constraints and maps `locations[]` with a non-null `pdf_url`. Version mapping: `publishedVersion` → `published`, `acceptedVersion` → `accepted`, `submittedVersion` → `submitted`, anything else → `unknown`.
    - `repository` is `location.source?.display_name ?? null`.
    - It sorts by version order, then dedupes by `pdfUrl`.
    - It never throws. Any HTTP or parse error returns `[]`.
  - `tryOpenAccess(doi: string, opts: { skipHost: string | null; deadline: Deadline; fetchImpl?: FetchLike; openAlexFetch?: FetchLike; lookupImpl?: LookupLike; maxPdfPages: number; maxTextChars: number }): Promise<{ copy: OaCopy; result: FullTextResult } | { copy: null; tried: number; firstUnextractable: OaCopy | null }>`.
    - It tries at most 3 copies, skipping `skipHost`, and stops when `deadline.remainingMs() < 10_000`.
    - Each copy is fetched with `fetchPublicResource` (no cookies). Only a response that `looksLikePdf` and extracts text counts. HTML landing pages are skipped.
- Produces: `GetFullTextOptions.openAlexFetch?: FetchLike` (default global `fetch`) and `GetFullTextOptions.openAccess?: boolean` (default `true`).
- Behavior in `getFullText`. When the result would be `blocked`, `not_proxied`, `not_entitled`, `login_required` (including no session) or `partial` with `textKind: 'abstract'`, **and** the target has a DOI:
  - **A copy works:** return `ok` with `version` = the copy's version, `sourceUrl` = the copy's URL, and a message that names the repository and says when the text isn't the published version. `readUrl` follows `finalizeResult` (`null` for `ok`).
  - **Nothing works:** keep the original result. Append `No open-access copy was found.`, or `An open-access copy exists at <url> but its text could not be extracted.` when `firstUnextractable` is set. `readUrl` stays the proxied or publisher link (decision 4).
  - **OpenAlex errors, or the deadline is short:** keep the original result and append `The open-access search was skipped.`

- [ ] **Step 1: Write the failing tests (`openAccess.test.ts`, mocked fetch only)**
  - Mapping and sorting: published before accepted, before submitted, before unknown, deduped.
  - The lookup URL percent-encodes `10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0` (Review Focus 1).
  - A 500 or non-JSON response from OpenAlex returns `[]`.
  - `tryOpenAccess`:
    - skips `skipHost`
    - stops after 3 copies
    - skips a copy whose `pdf_url` returns HTML (Review Focus 3) and takes the next one
    - refuses a `pdf_url` on `http://127.0.0.1/…` via the public-only guard and takes the next one (Review Focus 2)
    - sends no `Cookie` header on any request
- [ ] **Step 2: Write the failing `fullText.test.ts` cases**
  - `'a blocked Springer article falls back to a repository copy with version submitted'`: expect `status` `'ok'`, `version` `'submitted'`, `fullText` `true`, and the message mentioning the repository name and "submitted".
  - `'with no session, an open-access copy is still returned'`: no session file, OpenAlex has a published copy. Expect `ok`, `version` `'published'`, and that `fetchImpl` was never called with an `ezproxy` URL.
  - `'when no copy works, the original blocked result stays, with readUrl and a note'`.
  - `'OpenAlex failure never fails the call'`.
  - `'an abstract-only result upgrades to ok when a copy exists'`.
- [ ] **Step 3: Run the tests.** Expected: FAIL.
- [ ] **Step 4: Implement** as specified.
- [ ] **Step 5: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 6: Commit** `feat(fulltext): fall back to open-access copies via OpenAlex (#18)`

---

### Task 10: The agent-facing contract: tool descriptions, README, CHANGELOG

**Files:**
- Modify: `src/index.ts` (`get_full_text` description)
- Modify: `README.md` (`get_full_text` status table and fields)
- Modify: `CHANGELOG.md` (Unreleased)
- Test: `test/index.test.ts`

**Interfaces:**
- The `get_full_text` description must say, in this order:
  1. What it does: a DOI or an `alma`/`cdi_` recordId; EZproxy with a session; publishers not on the proxy fetched directly; open-access copies via OpenAlex, which also works without a session.
  2. **"If `fullText` is false, tell the user plainly that the full text was not retrieved and why, and show `readUrl` as a clickable link so they can open it in their browser."**
  3. **"If `textKind` is `abstract`, use the abstract to judge whether the paper is worth opening via `readUrl`."**
  4. `version` meanings: `null` means the publisher's version; otherwise `published`/`accepted`/`submitted`/`unknown`.
  5. The status list including `blocked`, with one clause on `blocked`: the publisher refused automated access; an agent with a browser can open `readUrl`, and the user handles any check there.
- README: add the `blocked` row and fix the `unsupported` row (bot walls are no longer `unsupported`). Document `fullText`, `readUrl`, `textKind` and `version`. Document `cdi_` support and that search filters combine (if Tasks 1 and 2 didn't already).
- CHANGELOG, under `## [Unreleased]`: list each change with its issue number under Added and Fixed.

- [ ] **Step 1: Write the failing test** in `test/index.test.ts`. List the tools via the in-memory client the suite already uses, and assert the `get_full_text` description contains `fullText`, `readUrl`, `clickable`, `textKind`, `abstract`, `blocked` and `cdi_`.
- [ ] **Step 2: Run `npx vitest run test/index.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement** the description, README and CHANGELOG.
- [ ] **Step 4: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Commit** `docs: describe fullText, readUrl, textKind, version and blocked for agents`

---

### Task 11: Honest User-Agent (#19). A separate, droppable commit.

**Files:**
- Modify: `src/ezproxy.ts` (`USER_AGENT`)
- Test: `test/ezproxy.test.ts`

**Interfaces:**
- Produces: `USER_AGENT = \`neu-onesearch-mcp/${version} (+https://github.com/sohampatwardhan/NEU-OneSearch-MCP)\``. Read `version` the same way `src/index.ts` does. Export it for the test.

- [ ] **Step 1: Write the failing test.**
  - `USER_AGENT` matches `/^neu-onesearch-mcp\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/sohampatwardhan\/NEU-OneSearch-MCP\)$/`.
  - `grep -rn "Mozilla/5.0" src/` finds nothing.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm run typecheck && npx vitest run`.** Expected: all PASS.
- [ ] **Step 5: Live gate (session required).** Run `npm run build`, then `getFullText` for:
  - Nature `10.1038/nature14539`
  - ACM `10.1145/3453155`
  - Wiley `10.1002/ett.4150`
  - Elsevier `10.1016/j.cose.2025.104509`

  Compare the results with the same calls on the previous commit (`git stash`/checkout `HEAD~1`, then build). **If any of them that was `ok` stops being `ok`, don't commit this task.** Report the difference to the owner and continue without it (decision 7).
- [ ] **Step 6: Commit** `feat(http): identify as neu-onesearch-mcp instead of a Chrome browser (#19)`

---

### Task 12: Bundled agent skill `neu-literature-review` (spec section 4)

**Files:**
- Create: `skills/neu-literature-review/SKILL.md`
- Modify: `package.json`. Add `"skills/**"` to `files`.
- Modify: `README.md`. Add an "Agent skill" section with `npx skills add sohampatwardhan/NEU-OneSearch-MCP --skill neu-literature-review` and a note that the CLI needs Node 22.20 or later.
- Modify: `CHANGELOG.md` (Unreleased, Added).
- Test: `test/skill.test.ts`

**Interfaces:**
- Consumes: the field and status names from Tasks 4, 6, 7 and 9, used verbatim: `fullText`, `readUrl`, `textKind`, `version`, `blocked`, `login_required`, `partial`.
- **Frontmatter:**
  - `name: neu-literature-review`
  - `description:` one sentence that starts with "Use when" and names Northeastern library literature reviews, OneSearch, and full-text retrieval.
- **Body:** covers the spec's section 4 content list, in that order. Keep it under 120 lines.
- **Approach:** follow `superpowers:writing-skills`. Write it, then run one subagent baseline: give it the skill and the mocked tool results for `blocked`, abstract-only and `ok`-with-`version: submitted`. Check that it tells the user plainly, shows `readUrl`, and labels the version. Revise once if not.

- [ ] **Step 1: Write the failing test** `test/skill.test.ts`:

```ts
const skill = readFileSync('skills/neu-literature-review/SKILL.md', 'utf8');
it('has the required frontmatter', () => {
  expect(skill).toMatch(/^---\nname: neu-literature-review\ndescription: Use when .+\n---\n/);
});
it.each(['fullText', 'readUrl', 'textKind', 'version', 'blocked', 'login_required', 'neu-onesearch-login'])('mentions %s', (term) => {
  expect(skill).toContain(term);
});
it('ships in the npm package', () => {
  expect(JSON.parse(readFileSync('package.json', 'utf8')).files).toContain('skills/**');
});
```

- [ ] **Step 2: Run `npx vitest run test/skill.test.ts`.** Expected: FAIL (file missing).
- [ ] **Step 3: Write the skill, `package.json`, README and CHANGELOG** as specified. Run the subagent baseline and revise once if needed.
- [ ] **Step 4: Check discovery locally.** `npx -y skills@1.7.6 add ./ --list` lists `neu-literature-review`. That's a read-only listing that installs nothing. If the local Node is older than 22.20, say so and skip this step.
- [ ] **Step 5: Run `npm run typecheck && npx vitest run && npm pack --dry-run | grep SKILL.md`.** Expected: all PASS, and `skills/neu-literature-review/SKILL.md` is in the pack list.
- [ ] **Step 6: Commit** `feat(skill): bundle the neu-literature-review agent skill`

---

### Task 13: Live verification and PR

**Files:**
- Create: `scripts/fulltext-live-check.mjs`. It runs `getFullText` from `dist/` on the spec's DOI table, plus the #11 multi-filter search and the #12 `cdi_` record, and prints one line per call: status, `fullText`, `textKind`, `version`, `charCount`, the `readUrl` host, and the first 80 characters of the message.

- [ ] **Step 1: Run `npm run build && node scripts/fulltext-live-check.mjs` with the session.** Expected: it matches the spec's "Status outcomes" table.
  - Every result with no text has a `readUrl`.
  - No `partial` or `ok` result contains challenge text.
  - If a probe meets a challenge, record it. Don't retry with variations.
- [ ] **Step 2: Push the branch and open a PR** to `main`:
  - **Title:** `Full-text coverage: combined filters, cdi_ records, blocked status, open-access fallback`.
  - **Body:**
    - a summary per task
    - the live-check output as a table
    - `Closes #12 #13 #14 #15 #16 #17 #18 #20`, plus `#19` if Task 11 landed, and `Closes #11` only if every row matches the spec's outcomes table
    - the attribution footer
