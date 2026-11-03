---
name: neu-literature-review
description: Use when running a literature review through the Northeastern library's OneSearch with the NEU OneSearch MCP tools, for searching, triaging abstracts, and full-text retrieval.
---

# NEU literature review

Use this with the `neu-onesearch` MCP server (`search_onesearch`, `get_record`, `get_full_text`) to find papers in Northeastern's library, read the ones that matter, and report honestly what you did and did not read.

## When to use

- The user wants sources, a literature review, a reading list, or a summary of what the literature says on a topic, and has Northeastern library access.
- Not for general web research. Search results only cover what Northeastern's OneSearch indexes.

## Workflow

1. **Search with combined filters.** `search_onesearch(query, limit?, resourceType?, dateFrom?, dateTo?, peerReviewedOnly?, sort?, campus?)`. The filters combine (AND) in one call, so set them together instead of filtering by hand afterwards. Run several differently worded queries for one topic; one query rarely covers it.
2. **Triage by abstract.** Results usually carry a description or abstract. Read these first and shortlist. Use `get_record(recordId)` (`alma...` or `cdi_...` ids) when a result lacks detail. Do not fetch full text for every hit.
3. **Fetch full text for the shortlist.** `get_full_text(doi)` or `get_full_text(recordId)`. Prefer the DOI when the result has one.
4. **Synthesize from what you actually read.** Cite every paper by DOI. Say which claims come from full text and which only from an abstract.

## Reading a `get_full_text` result

| Field | Meaning |
| --- | --- |
| `fullText` | `true` only when `status` is `ok`. Anything else means you did not get the paper. |
| `readUrl` | Link the user can open in a browser. Present when a link could be built; it can be `null` (for example when no target was given). |
| `textKind` | `article`, `abstract` or `unknown`. |
| `version` | `null` is the publisher's version. `published`, `accepted`, `submitted` or `unknown` marks an open-access copy. |
| `text`, `message` | The text (if any) and a plain-language explanation. |

## Honesty rules

- If `fullText` is false, tell the user plainly that the full text was not retrieved, give the reason from `message`, and show `readUrl` as a clickable link so they can open it. If `readUrl` is `null`, say there is no link; never invent one.
- Never present `partial` or abstract text as the paper. Label it "abstract only". Do not summarize methods, results or limitations from an abstract as if you had read the body.
- If `textKind` is `abstract`, use the abstract to judge whether the paper is worth opening via `readUrl`, and say that is what you did.
- If `version` is not `null`, say which version you read (for example "accepted manuscript, not the published version"). Quotes and page numbers may differ from the published paper.
- Never invent text, DOIs or citations. If a paper was not retrieved, say so and do not fill in details from memory.
- If a status is `error` or `not_found`, report it and move on. Do not retry in a loop.

## Statuses and what to do

- `ok`: read `text` and cite the DOI. If `version` is not `null`, the library route failed and this is an open-access copy; say which version you read.
- `partial`: you have an abstract or a fragment. Treat it as an abstract. Show `readUrl`.
- `login_required`: no valid NEU session. Tell the user to run `neu-onesearch-login` and complete the NEU sign-in and Duo prompt themselves in the browser window it opens. Never ask for or type their credentials. Retry once only after the user says they have signed in.
- `blocked`: the publisher showed a bot check, challenge page or other access wall. Do not try to get around it, solve a CAPTCHA, or retry with variations. Show `readUrl`. If your harness has a browser, you may open `readUrl` for the user; they handle any sign-in or check themselves. Otherwise just give the link.
- `not_proxied`, `not_entitled`: the library proxy cannot reach it, or Northeastern has no access. Show `readUrl`.
- `too_large`, `unsupported`: the file could not be read as text. Show `readUrl`.
- `not_found`, `error`: report the `message`. If you typed the identifier by hand, verify it once against the search result; otherwise just report it.

## Sign-in

Search and `get_record` work without signing in. Full text through the library proxy needs a session from `neu-onesearch-login`. Open-access copies found through OpenAlex need no session. Only the user completes sign-in and Duo. Never handle passwords, codes or cookies.

## Report format

End a review with a short list per paper: title, DOI, and one of `full text read` (with `version` if not published), `abstract only`, or `not retrieved` with its `readUrl`. The user should be able to see at a glance which claims rest on which level of reading.
