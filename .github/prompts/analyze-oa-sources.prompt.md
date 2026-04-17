---
description: "Analyze a new open-access source/API and propose a ZotFetch SourceResolver implementation for it"
name: "ZotFetch: Analyze & Add OA Source"
argument-hint: "Name or URL of the OA database, repository, or API to integrate"
agent: "agent"
tools: [fetch_webpage, read_file, replace_string_in_file, semantic_search]
---

# Analyze and Integrate a New OA Source into ZotFetch

You are integrating a new open-access (OA) data source into the **ZotFetch** Zotero plugin.

## Context

ZotFetch fetches PDF attachments for Zotero items using a pipeline of `SourceResolver` classes (in [chrome/content/source-resolvers.mjs](../../chrome/content/source-resolvers.mjs)) that produce `SourceCandidates`, which `PDFResolver` classes (in [chrome/content/pdf-resolvers.mjs](../../chrome/content/pdf-resolvers.mjs)) then resolve to final PDF URLs.

## Task

Given the OA source `{{argument}}`, do the following:

### 1. Feasibility analysis
- Fetch the source's homepage and API documentation to determine if it has a **public API** that returns a direct PDF URL (or landing page) given a DOI, PMID, or arXiv ID.
- Report: endpoint URL, required parameters, authentication, rate limits, response format (key fields), and HTTP status codes.
- Note if the source is already covered by an existing resolver (Unpaywall, OpenAlex, CORE, EuropePMC, Semantic Scholar, Internet Archive/Fatcat, Paperity, OA.mg).

### 2. Value assessment
Estimate the marginal coverage gain:
- Does it index papers **not covered** by Unpaywall or CORE?
- Is it discipline-specific (e.g. biomedical, social science, humanities)?
- Does it provide **direct PDF URLs** or only HTML landing pages?
- Is the API stable and free for polite automated use?

### 3. Implementation (if feasible)
If the source adds real coverage:
- Implement a new `var XyzSourceResolver = class { … }` following the exact pattern of existing resolvers in `source-resolvers.mjs`.
- Assign an appropriate `priority` (see existing resolver priorities in the file).
- Add the resolver to `_buildSourceResolvers()` fast list in `fetch.mjs`.
- Add a stats counter (`xyz: 0`) to the `stats` object in `runBatch()`.
- Track it in the success block (`else if (sid === "xyz") stats.xyz++`).
- Append it to the completion text string (conditional, like other minor sources).
- If the domain serves real PDFs, add it to `SAFE_OA_HOSTS` in `fetch.mjs`.
- Export the class at the bottom of `source-resolvers.mjs`.

### 4. Security checklist
Before finalising, verify:
- All URLs from the API are validated against `^https?:\/\/` before being passed to `Zotero.HTTP.request`.
- No user-supplied strings are interpolated into query parameters without `encodeURIComponent`.
- No credentials are stored in plain prefs (use `SecureStorage` for any API keys).

### 5. Summary
Return a concise summary:
- API endpoint used
- Parameters and auth required
- Priority assigned
- Estimated coverage vs existing resolvers
- Any caveats (rate limits, domain coverage, reliability)
