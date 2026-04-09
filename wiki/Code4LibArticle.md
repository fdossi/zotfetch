# ZotFetch: A Modular, Multi-Source Batch PDF Retrieval Plugin for Zotero

**Fabio Dossi**

---

## Abstract

Researchers who manage large reference libraries in Zotero frequently face a labour-intensive task: locating and attaching full-text PDFs to hundreds or thousands of bibliographic records. Existing tools address this only partially — Zotero's own PDF finder is single-item and rate-limited; dedicated scripts operate outside Zotero's data model; no freely available tool supports institutional proxy authentication in bulk. This paper describes ZotFetch, a Zotero 8 plugin that automates batch PDF retrieval through a modular two-stage pipeline. The first stage (source resolution) queries a priority-ordered set of open-access APIs — including Unpaywall, Semantic Scholar, OpenAlex, Europe PMC, CORE, and DOI landing pages — as well as configurable institutional proxy and CAPES portal endpoints. The second stage (PDF resolution) validates each candidate URL, distinguishing direct PDF links from publisher landing pages, and applies publisher-specific and generic HTML-extraction rules to locate the real file before import. The plugin includes adaptive rate limiting, per-domain captcha tracking, a two-pass Fast Mode, and a graphical preferences dialog requiring no access to `about:config`. In informal testing across mixed-discipline collections, ZotFetch successfully retrieved attachments for a substantial proportion of OA-available items in a single unattended run. ZotFetch is freely available at [https://github.com/fdossi/zotfetch](https://github.com/fdossi/zotfetch) under the MIT License (DOI: 10.5281/zenodo.19149482).

---

## 1. Introduction

Reference management software is a cornerstone of academic research practice. Among the tools currently in wide use, Zotero stands out for its open architecture, browser integration, and extensible plugin system [CITE_ZOTERO]. A persistent practical problem for Zotero users — particularly those migrating from other systems, inheriting legacy libraries, or conducting retrospective reviews — is the absence of full-text PDF attachments on bibliographic records. A collection of 1,000 items might have 200–400 PDFs missing, depending on how the library was built and whether the user had consistent institutional access at the time of import.

Zotero provides a "Find Available PDF" function accessible via right-click, but it operates on one item at a time and is subject to the same rate limits as any individual API call. For a library of any substantial size, manually triggering this function — and then following up on failures — is prohibitively time-consuming. Third-party workarounds exist (browser automation scripts, command-line utilities), but they operate outside Zotero's native data model, require technical expertise to configure, and do not integrate with Zotero's attachment management system.

ZotFetch was developed to fill this gap: a Zotero plugin that retrieves PDFs in bulk, integrates transparently with Zotero's attachment API, supports institutional authentication mechanisms common in academic library settings, and handles the adversarial conditions (rate limits, captchas, landing-page redirects) that bulk retrieval inevitably encounters.

This paper describes the design of ZotFetch, its source priority system, its two-stage pipeline architecture, its approach to rate limiting and captcha avoidance, and its mechanisms for institutional access integration.

---

## 2. Background and Related Work

### 2.1 Open Access PDF Discovery APIs

Several APIs now provide programmatic access to OA full-text locations. **Unpaywall** (Piwowar et al., 2018) is the most widely used, indexing open-access versions of scholarly articles by DOI. **OpenAlex** (Priem et al., 2022) provides a `best_oa_location` field for a large fraction of its 250+ million records. **Semantic Scholar** (Ammar et al., 2018) exposes an `openAccessPdf` field via its Graph API. **CORE** (Knoth & Zdrahal, 2012) aggregates 234 million records from institutional repositories worldwide and provides a REST API with PDF URL fields. **Europe PMC** covers biomedical literature with PMID or DOI identifiers and returns verified OA status.

These APIs collectively cover a large fraction of OA-available literature, but coverage varies substantially by discipline, publication year, and publisher. No single source is sufficient; a retrieval system must query several in sequence and handle failures gracefully.

### 2.2 Institutional Access Mechanisms

For paywalled content, institutional proxy servers (commonly EZproxy, published by OCLC) provide authenticated access by prepending a proxy URL to the target article URL. Researchers with valid institutional credentials and an active proxy session can access paywalled content transparently. In Brazil, the CAPES Periódicos portal provides federal and state university affiliates with centralised access to thousands of journal subscriptions; the portal operates via CAFe (Comunidade Acadêmica Federada) federated authentication.

Integrating these access mechanisms into a bulk retrieval workflow requires correctly formatting proxy URLs (several patterns are in common use), routing the right requests through the proxy, and gracefully handling authentication failures.

### 2.3 Existing Tools

Several tools attempt bulk PDF retrieval for Zotero. ZotFile [CITE_ZOTFILE] handles PDF file management and renaming but does not retrieve new attachments. Zotero's built-in "Find Available PDF" is single-item only. Browser-based automation scripts (e.g., Tampermonkey scripts targeting Google Scholar or ResearchGate) operate outside Zotero's data model and require manual intervention. ZotMoov and similar plugins manage attachment filing but do not perform retrieval. To the best of the author's knowledge, no prior plugin offers multi-source, proxy-aware, bulk PDF retrieval as a first-class Zotero feature.

---

## 3. System Architecture

ZotFetch implements a two-stage pipeline: **source resolution** followed by **PDF resolution**, with a subsequent **attachment import** step (Figure 1).

```
processItem(item)
    │
    ├─ IdentifierExtractor.fromItem()
    │   extracts: DOI, arXiv ID, PMID, URL, title, year, firstAuthor
    │
    ├─ SourceResolver[].buildCandidates()
    │   returns: SourceCandidate[] sorted by priority
    │   (each candidate carries: url, kind, headers, meta)
    │
    └─ for each candidate (in priority order):
         PDFResolver[].resolve(candidate, ctx)
         ├─ DirectPDFResolver
         │   HEAD/GET + Content-Type: application/pdf check
         ├─ PublisherPatternResolver
         │   publisher-specific DOM rules (12 publishers)
         └─ HtmlLandingPDFResolver
             generic meta/link/iframe/anchor extraction
         └─ AttachmentImporter.importResolvedPdf()
             wraps Zotero.Attachments.importFromURL()
```

**Figure 1.** ZotFetch processing pipeline for a single item.

### 3.1 Identifier Extraction

Before querying any source, ZotFetch extracts all available identifiers from the Zotero item: DOI (from the dedicated field, URL field, Extra field, or embedded in the item URL), arXiv ID, PMID, the item's URL, title, year, and first author. If a DOI is absent, ZotFetch performs an automatic lookup via the CrossRef API using title and author metadata. This step is critical for older imports or records sourced from databases that do not attach DOIs.

### 3.2 Source Resolution

Source resolvers are modular classes that implement a simple interface:

- `id` — unique string identifier for the source
- `enabled()` — returns a boolean based on preferences and available credentials
- `buildCandidates(item, ids)` — returns a `Promise<SourceCandidate[]>`

Each `SourceCandidate` carries a URL, a `kind` field (`direct-pdf` or `landing-page`), suggested HTTP headers, and source-specific metadata. Candidates from all enabled resolvers are collected, deduplicated by URL, and sorted by priority before the PDF resolution stage begins.

Table 1 lists the source resolvers included in ZotFetch v1.4.0, their priority weights, and the APIs or mechanisms they use.

**Table 1.** Source resolvers in ZotFetch v1.4.0, sorted by priority.

| Priority | Source | Mechanism |
|---|---|---|
| 110 | Zotero Native OA | Zotero's built-in `findPDF` API (Unpaywall, OA Button) |
| 100 | Unpaywall | REST API, DOI lookup, `best_oa_location.url_for_pdf` |
| 95 | Semantic Scholar | Graph API `/paper/{id}`, `openAccessPdf.url` |
| 90 | OpenAlex | REST API, `best_oa_location.pdf_url` |
| 89 | Europe PMC | REST API, PMID or DOI, `fullTextUrlList` OA entries |
| 88 | CORE | REST API (`core.ac.uk/v3`), `downloadUrl` |
| 85 | OA Repository | Item URL field, if host is on a curated safe-OA list |
| 83 | Zotero Native (DOI) | Zotero translator-based DOI resolver |
| 80 | DOI Landing | Follows `doi.org/{doi}`, classifies result as landing page |
| 75 | Institutional Proxy | Wraps DOI URL through configured proxy |
| 72 | Institutional Proxy (S2) | Wraps S2 OA PDF URL through configured proxy |
| 70 | CAPES | Brazilian CAPES portal, DOI-based access |

### 3.3 PDF Resolution

Not all source candidates point directly to a PDF file. Publisher DOI redirects, for example, commonly land on an article page that contains a "Download PDF" button rather than a direct file link. The PDF resolution stage handles this by attempting a sequence of resolvers against each candidate until one succeeds:

1. **DirectPDFResolver**: Issues a HEAD request (falling back to GET) and inspects the `Content-Type` header. If `application/pdf` is returned, the URL is accepted as-is.

2. **PublisherPatternResolver**: For candidates classified as landing pages, applies publisher-specific DOM rules. Publisher patterns are implemented for Springer/SpringerLink, Nature, Wiley, Taylor & Francis, ACS, IEEE, MDPI, Frontiers, Elsevier/ScienceDirect, and SciELO.br. Each rule targets the specific HTML structure used by that publisher to embed the PDF download link.

3. **HtmlLandingPDFResolver**: A generic fallback that fetches the page with `responseType: "document"`, parses it as a DOM tree, and searches for PDF links in this order:
   - `<meta name="citation_pdf_url" content="…">`
   - `<link rel="alternate" type="application/pdf" href="…">`
   - `<iframe>`, `<embed>`, or `<object>` elements with a PDF `src`
   - `<a>` links whose `href` ends in `.pdf` or whose text contains "Download PDF"

This layered approach means ZotFetch can retrieve PDFs from publisher sites whose HTML ZotFetch has never explicitly seen, as long as they follow any of the common metadata or link conventions.

---

## 4. Download Modes

ZotFetch offers three download modes controlled by the Fast Mode preference:

**Fast Mode** (default) implements a two-pass strategy. In Pass 1, all OA sources (priorities 110–75) are queried. In Pass 2, only items that failed Pass 1 are retried, using the CAPES resolver and institutional fallbacks. This design keeps institutional proxy traffic proportional to the number of genuinely paywalled items, reducing load on proxy servers and minimising the risk of institutional IP reputation issues.

**Ultra Fast Mode** runs all sources in a single pass, skipping the CAPES fallback. It is designed for rapid first sweeps of large collections, where the user intends to follow up with a standard Batch Download run for remaining failures.

**Full Mode** (Fast Mode disabled) runs all sources in a single comprehensive pass with no deferral, including CAPES.

---

## 5. Rate Limiting and Captcha Avoidance

Bulk HTTP requests to publisher infrastructure carry the risk of triggering rate limits, IP blocks, or CAPTCHA challenges. ZotFetch mitigates these risks through several mechanisms operating at different timescales.

### 5.1 Per-Domain Request Spacing

ZotFetch maintains a per-domain timestamp of the most recent request. Before issuing a new request to any domain, it checks the elapsed time against a configurable minimum (`domainGapMs`, default 1,500 ms). A ±60% random jitter is applied to base delays to avoid predictable cadence patterns.

### 5.2 Adaptive Exponential Backoff

Non-captcha failures (timeouts, network errors, 5xx responses) trigger an exponential backoff counter per domain: the wait before the next request to that domain increases by 1 s, 2 s, 4 s, up to a cap of 15 s. The counter resets on any success.

### 5.3 Cross-Item Captcha Tracking

Publishers known to challenge automated requests heavily (Elsevier, Wiley, Springer, ACS) are excluded from the Zotero-native resolver paths entirely; ZotFetch uses randomised browser User-Agent strings for direct HTTP requests to those domains. If a CAPTCHA response is nevertheless detected (identified by response body heuristics), the affected domain is placed in a penalty cooldown for the remainder of the current batch. A domain that triggers 3 or more captchas in a single session is blocked for 30 minutes. This prevents a single aggressive publisher from consuming the entire batch budget on repeated captcha responses.

### 5.4 Retry After Auth

The **Retry After Auth** command addresses the case where interactive authentication is required. ZotFetch collects items classified as `auth`-failed or `captcha`-failed, opens their DOI URLs in the system browser (up to 3 at a time), waits for the user to complete the login or captcha challenge, then retries those items. This allows human-in-the-loop resolution of authentication barriers without abandoning the batch workflow.

---

## 6. Institutional Access Integration

### 6.1 EZproxy and Authentication Gateways

ZotFetch supports four institutional proxy URL formats:

| Format | Example |
|---|---|
| `?url=` suffix | `https://proxy.myuniversity.edu/login?url=` |
| `?qurl=` suffix | `https://eresources.myuniversity.edu/login?qurl=` |
| `{url}` placeholder | `https://proxy.myuniversity.edu/login?qurl={url}` |
| Bare base URL | `https://proxy.myuniversity.edu` |

When an institutional proxy URL is configured, ZotFetch adds two source resolvers at priorities 75 and 72. These resolvers wrap the item's DOI URL — and the Semantic Scholar OA PDF URL, respectively — through the proxy, encoding the target URL appropriately for the detected format. This means the institutional proxy is consulted automatically for all items that OA sources fail to resolve, without any per-item user action.

### 6.2 CAPES Portal

For Brazilian institutions affiliated with CAPES, ZotFetch provides a dedicated CAPES resolver that wraps DOI URLs through the configured CAPES gateway. The toggle and gateway URL are configurable in the Preferences dialog. The resolver activates only in the second pass of Fast Mode and during Retry Failed runs — preserving CAPES bandwidth for items that genuinely require it.

---

## 7. Preferences and Configuration

All settings are exposed through a graphical preferences dialog, accessed via **right-click → ZotFetch ▶ → Preferences**. Settings include: email address (for Unpaywall/OpenAlex/CrossRef), CORE API key, institutional proxy URL, CAPES gateway URL, CAPES toggle, Fast Mode toggle, batch size, request delay, domain gap, anti-captcha mode, and HTTP timeouts. A **? Help** button in the dialog links to the online user manual.

All preferences are also accessible via Zotero's `about:config` under the `extensions.zotfetch.*` namespace, which allows scripted or policy-based deployment.

---

## 8. Limitations

**JavaScript-rendered pages.** Some publisher landing pages (notably ScienceDirect's SPA renderer) require JavaScript execution to reveal the PDF download link. ZotFetch uses a heuristic extraction from inline `<script>` blocks as a best-effort approach, but may miss items where the PDF URL is constructed entirely client-side.

**Authenticated sessions outside Zotero.** The institutional proxy integration relies on the proxy accepting the credentials embedded in the URL or on pre-existing cookie-based sessions. Single Sign-On systems that require a browser-based OAuth flow cannot be automated through this mechanism.

**API coverage gaps.** OA API coverage varies by discipline and publication year. For highly specialised, older, or grey literature, all API sources may return no result, and the plugin falls back to the institutional proxy or reports a failure. Manual attachment is required for these items.

**Batch size practical limits.** While the batch size is configurable (default: 30 items per run), very large selections (hundreds of items) are best processed in multiple runs or with conservative delay settings, particularly when using publisher landing-page extraction paths that involve direct HTTP connections to publisher infrastructure.

---

## 9. Conclusion

ZotFetch addresses a real and common workflow problem in library and research practice: the bulk back-filling of PDF attachments in an existing Zotero library. Its modular, priority-ordered pipeline cleanly separates source discovery from PDF extraction; its adaptive rate limiter and captcha-tracking system make unattended batch runs practical; and its institutional proxy integration brings CAPES and EZproxy access into Zotero's native attachment workflow without requiring any per-item user action.

The plugin is freely available, MIT-licensed, and designed for extension: new source resolvers and PDF extractors can be added by implementing a two-method interface, without modifying the orchestration code.

Future development directions include: support for OpenAthens token-based authentication; integration with library link resolvers (OpenURL); expanded publisher-specific DOM rules; and a structured logging export for collection-level analysis of OA availability.

ZotFetch is available at [https://github.com/fdossi/zotfetch](https://github.com/fdossi/zotfetch). The current release (v1.4.0) is archived at [https://doi.org/10.5281/zenodo.19149482](https://doi.org/10.5281/zenodo.19149482).

---

## References

Ammar, W., Groeneveld, D., Bhagavatula, C., Luan, Y., Lo, K., Downey, D., … Hajishirzi, H. (2018). Construction of the Literature Graph in Semantic Scholar. *Proceedings of NAACL-HLT 2018*, 84–91. https://doi.org/10.18653/v1/N18-3011

Knoth, P., & Zdrahal, Z. (2012). CORE: Three Access Levels to Underpin Open Access. *D-Lib Magazine*, 18(11/12). https://doi.org/10.1045/november2012-knoth

Piwowar, H., Priem, J., Larivière, V., Alperin, J. P., Matthias, L., Norlander, B., … Haustein, S. (2018). The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles. *PeerJ*, 6, e4375. https://doi.org/10.7717/peerj.4375

Priem, J., Piwowar, H., & Orr, R. (2022). OpenAlex: A fully-open index of the world's research works. *arXiv*. https://doi.org/10.48550/arXiv.2205.01833

Zotero. (2025). *Zotero — Your personal research assistant*. Digital Scholar. https://www.zotero.org
