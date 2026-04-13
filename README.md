# ZotFetch: Batch PDF Downloader for Zotero

[![DOI](https://zenodo.org/badge/1186582529.svg)](https://doi.org/10.5281/zenodo.19149482)

**Author:** Fabio Dossi &nbsp;|&nbsp; **Version:** 1.5.0 &nbsp;|&nbsp; [📖 User Manual (Wiki)](https://github.com/fdossi/zotfetch/wiki)

**ZotFetch** is a [Zotero 8](https://www.zotero.org/) plugin that automatically downloads PDFs for multiple library items in a single operation. It uses a modular two-stage pipeline — **source resolution** then **PDF extraction** — so that landing pages from publishers, proxies, and repositories are correctly resolved to their actual PDF URL before import.

---

## Features

- **Two-stage pipeline**: SourceResolver → PDFResolver → AttachmentImporter. Landing pages are never accidentally imported as PDFs.
- **Multi-source download**: Native OA → Unpaywall → Semantic Scholar → OpenAlex → Europe PMC → CORE → OA Repository (+ arXiv direct-pdf) → Zotero Native DOI → DOI Landing → Institutional Proxy → CAPES
- **PMCID support**: extracts `PMCID: PMCxxxxxxx` from item metadata for an instant Europe PMC fast path — no API call needed
- **HTML-to-PDF extraction**: publisher-specific rules (Springer, Nature, Wiley, Taylor & Francis, ACS, Royal Society of Chemistry, SAGE, Oxford University Press, IEEE, MDPI, Frontiers, Elsevier/ScienceDirect, SciELO.br), a generic HTML extractor, or a **Gecko hidden browser** that automatically solves Cloudflare/Akamai JS challenges
- **Fast Mode**: Two-pass strategy — lightweight open-access sources first, institutional fallbacks only for unresolved items
- **Ultra Fast Mode**: Single-pass, maximum speed, prioritises open-access sources
- **Adaptive rate limiting**: Per-domain request spacing with exponential backoff on failures
- **Anti-captcha protection**: Tracks consecutive captcha hits per domain; blocks domain after 3 hits, resets on success
- **DOI lookup**: Automatically resolves missing DOIs via CrossRef before attempting downloads
- **Retry Failed Items / Retry After Auth**: Targeted retry flows for failed or auth-blocked items
- **Live progress**: Color-coded status (🔵/🟢/🟡/🔴) with `PDFs X/Y (Z%)` counter
- **Institutional proxy**: Configurable EZproxy/Shibboleth URL for legal paywalled access; Semantic Scholar links are also routed through the proxy when applicable
- **Extensible**: New SourceResolvers and PDFResolvers can be added without touching the orchestration code

---

## Installation

### From a release XPI

1. Download `zotfetch-X.Y.Z.xpi` from the [Releases](https://github.com/fdossi/zotfetch/releases) page
2. In Zotero, go to **Tools → Add-ons**
3. Click the gear icon (⚙️) → **Install Add-on From File…**
4. Select the downloaded `.xpi` file
5. Restart Zotero when prompted

### From source

Requirements: Python 3.8+

```bash
git clone https://github.com/fdossi/zotfetch.git
cd autoPDFdownloader
python build.py --clean
```

This creates `zotfetch-X.Y.Z.xpi`. Install it via the steps above.

---

## Usage

Select one or more items in your Zotero library, then right-click and hover over **ZotFetch ▶** to open the submenu:

| Command | Description |
|---|---|
| **Batch Download** | Downloads PDFs for all selected items using all sources (two-pass if Fast Mode is on) |
| **Ultra Fast** | Single-pass, fastest mode — open-access sources only. May download fewer PDFs than Batch Download. |
| **Retry Failed** | Re-attempts only items that failed in the most recent batch |
| **Retry After Auth** | Opens up to 3 DOI URLs in your browser for manual login/captcha, then retries blocked items |
| **Preferences** | Opens the graphical Preferences dialog |

---

## Download Sources

ZotFetch tries sources in this order of priority:

| Priority | Source | Notes |
|---|---|---|
| 110 | **Native OA** | Zotero's built-in open-access finder |
| 100 | **Unpaywall** | Free legal OA PDF lookup (requires email). Collects direct PDF URLs and OA landing pages across all OA locations. |
| 95 | **Semantic Scholar** | Graph API `openAccessPdf` field; falls back to arXiv direct-pdf when S2 knows the arXiv ID |
| 90 | **OpenAlex** | `best_oa_location` PDF URL or OA landing page |
| 89 | **Europe PMC** | Biomedical papers. Instant direct URL when PMCID is known; API search via PMID or DOI otherwise |
| 88 | **CORE** | [core.ac.uk](https://core.ac.uk/) — 234M+ institutional repository records. Free key recommended. |
| 86–85 | **OA Repository** | Direct arXiv PDF when arXiv ID is known (86); item URL when host is in the safe OA list (85) |
| 83 | **Zotero Native (DOI)** | Zotero's translator-based DOI resolver. On institutional IP/VPN, resolves paywalled PDFs automatically. |
| 80 | **DOI Landing** | Publisher page via doi.org (HTML→PDF extraction) |
| 75–72 | **Institutional Proxy** | DOI routed through your proxy; also routes Semantic Scholar PDF URLs through the proxy |
| 70 | **CAPES** | Brazilian CAPES portal or custom DOI proxy URL |

In **Fast Mode**, sources 110–75 run in Pass 1; unresolved items proceed to Pass 2 (CAPES and institutional fallbacks). In **Ultra Fast Mode**, all sources run in a single pass.

> **Note:** Additional fallback sources can be enabled in `about:config`. See the Configuration section for available options.

### HTML-to-PDF extraction (landing pages)

When a source returns a landing page URL (not a direct PDF), ZotFetch tries to find the real PDF link in this order:

1. **Publisher-specific rule** (Springer, Nature, Wiley, Taylor & Francis, ACS, Royal Society of Chemistry, SAGE, Oxford University Press, IEEE, MDPI, Frontiers, Elsevier/ScienceDirect, SciELO.br)
2. **Generic HTML extractor**: `<meta name="citation_pdf_url">`, `<link rel="alternate" type="application/pdf">`, `<iframe>` / `<embed>` / `<object>` with PDF src, `<a>` links to `.pdf` or with "Download PDF" text
3. **Gecko hidden browser** (`Zotero.HTTP.processDocuments`): for URLs where steps 1–2 failed, loads the page in a full hidden Firefox engine. Automatically passes Cloudflare "Just a moment…" and Akamai Bot Manager JS challenges. Publisher-specific rules and generic extraction are then re-applied on the fully rendered DOM.

Each candidate URL is validated by a HEAD request confirming `Content-Type: application/pdf` before the file is imported.

---

## Configuration

Open the graphical settings dialog via **right-click → ZotFetch ▶ → Preferences**. It covers all options grouped into sections — no need to use `about:config`.

Click **? Help** in the dialog to open the [User Manual](https://github.com/fdossi/zotfetch/wiki) with detailed setup instructions for institutional proxy and CAPES.

All preferences are also editable directly in **`about:config`** (Zotero's advanced config editor, **Edit → Settings → Advanced → Config Editor**), filtering by `extensions.zotfetch`.

> **Security note (v1.4.3+):** Sensitive credentials — email, API key, and proxy URLs — are stored in Zotero's encrypted Login Manager, **not** in `about:config`. Use the **Preferences dialog** to set or change them; editing the `extensions.zotfetch.*` pref keys for these fields in `about:config` has no effect.

| Preference key | Default | Description |
|---|---|---|
| `extensions.zotfetch.fastMode` | `true` | Enables two-pass Fast Mode |
| `extensions.zotfetch.batchSize` | `30` | Max items to process per batch run |
| `extensions.zotfetch.requestDelayMs` | `900` | Base delay between requests (ms), ±60% jitter applied |
| `extensions.zotfetch.domainGapMs` | `1500` | Minimum gap between requests to the same domain (ms) |
| `extensions.zotfetch.requestTimeoutMs` | `15000` | Per-request HTTP timeout (ms) |
| `extensions.zotfetch.antiCaptchaMode` | `true` | Skip domains that are currently in cooldown |
| `extensions.zotfetch.enableCapesFallback` | `true` | Enable CAPES/DOI proxy as a fallback source |
| `extensions.zotfetch.unpaywallTimeoutMs` | `12000` | Timeout for Unpaywall API requests (ms) |
| `extensions.zotfetch.crossrefTimeoutMs` | `10000` | Timeout for CrossRef DOI lookup (ms) |

**Credentials (managed via Preferences dialog only — stored in encrypted Login Manager):**

| Field | Description |
|---|---|
| Email address | Your email for Unpaywall/OpenAlex/CrossRef API access. **Required** for most sources. |
| Institutional Proxy URL | Your institution's EZproxy URL, e.g. `https://proxy.myuniversity.edu/login?url=` |
| CAPES Gateway URL | CAPES authenticated gateway URL |
| CORE API Key | Free key from core.ac.uk/services/api (optional) |

### Institutional proxy URL formats

ZotFetch supports all common proxy URL patterns:

| Format | Example |
|---|---|
| Template placeholder | `https://proxy.myuniv.edu/login?url={url}` |
| Direct query parameter | `https://proxy.myuniv.edu/?url=` |
| Query string | `https://proxy.myuniv.edu/proxy?url=` |
| EZproxy bare base | `https://proxy.myuniv.edu` |

---

## Architecture

```
processItem()
├─ IdentifierExtractor.fromItem()          (identifiers.mjs)
│    extracts DOI, arXiv ID, PMID, PMCID, URL, title, year, firstAuthor
├─ SourceResolver[].buildCandidates()      (source-resolvers.mjs)
│    returns SourceCandidate[] sorted by priority
└─ for each candidate:
     PDFResolver[].resolve()               (pdf-resolvers.mjs)
     ├─ DirectPDFResolver                  HEAD/GET, confirm Content-Type: application/pdf
     ├─ PublisherPatternResolver           publisher-specific DOM rules
     ├─ HtmlLandingPDFResolver             generic meta/link/iframe/anchor extraction
     └─ HiddenBrowserPDFResolver           Gecko JS engine (Cloudflare/Akamai challenges)
     AttachmentImporter.importResolvedPdf() (importer.mjs)
```

### Adding a new source

1. Create a class in `source-resolvers.mjs` that implements:
   - `id` — unique string identifier
   - `enabled()` — returns `boolean`
   - `buildCandidates(item, ids)` — returns `Promise<SourceCandidate[]>`
2. Add it to `_buildSourceResolvers()` in `fetch.mjs` at the appropriate priority position.

### Adding a new PDF extractor

1. Create a class in `pdf-resolvers.mjs` that implements:
   - `canResolve(candidate)` — returns `boolean`
   - `resolve(candidate, ctx)` — returns `Promise<PDFResolutionResult>`
2. Add it to `_buildPdfResolvers()` in `fetch.mjs`.

---

## How Anti-Captcha and Rate Limiting Work

ZotFetch tracks request history per domain:

- **Domain gap**: Waits at least `domainGapMs` milliseconds between requests to the same domain
- **Adaptive backoff**: Exponential extra wait on consecutive non-captcha failures (+1 s, +2 s, +4 s… capped at +15 s). Resets on any success.
- **Captcha threshold**: After 3 consecutive captcha responses from the same domain, that domain is blocked for 30 minutes
- **Failure classification**: `cloudflare` → `captcha` → `auth` → `blocked` → `timeout` → `nopdf` → `network`

---

## Requirements

- **Zotero 8.0.4** or later (not compatible with Zotero 7 or earlier)
- A registered email address for [Unpaywall](https://unpaywall.org/) (free, no sign-up required — just a valid email in the preferences)

---

## Known Limitations

- **Captcha-blocked sessions**: When a publisher serves a captcha, use **ZotFetch ▶ Retry After Auth** to open the URL in your browser, solve the captcha, then retry.
- **JavaScript-rendered publisher pages**: ZotFetch now includes a Gecko hidden browser (`HiddenBrowserPDFResolver`) as the last-resort resolver. It runs a full Firefox engine, automatically passing Cloudflare "Just a moment…" and Akamai Bot Manager JS challenges. Only human-verification CAPTCHAs (reCAPTCHA checkbox, hCaptcha image grids) still require manual intervention via **Retry After Auth**.
- **Paywalled content without proxy**: Without an institutional proxy configured, ZotFetch can only retrieve freely available (OA) versions of paywalled articles.

---

## License

Released under the [MIT License](LICENSE).

Contributions via pull requests are welcome.

---

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. IN NO EVENT SHALL THE AUTHOR OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY — WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE — ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

**The user assumes all risks and sole responsibility for any consequences arising from the use of this plugin.** This includes, but is not limited to, any legal, institutional, or technical consequences related to the access, download, or storage of copyrighted materials. The author makes no representations regarding the legality of any particular use of this plugin in any given jurisdiction. It is the user's responsibility to ensure compliance with all applicable laws, institutional policies, and the terms of service of any platform or content provider accessed through this plugin.

---

## Changelog

### v1.4.3 — Encrypted credential storage + paywalled-items advisory
- **Security**: Sensitive credentials (email, API key, institutional proxy URL, CAPES URL) are now stored in Zotero's **encrypted Login Manager** (`nsILoginManager`) instead of plain-text SQLite prefs. Credentials are protected by the OS keychain or Zotero master password.
- **Migration**: On first startup after upgrading, any existing plain-text pref values are automatically migrated to SecureStorage and wiped from `extensions.zotfetch.*` prefs — no user action required.
- **New**: After a batch run, if items failed due to subscription walls and no institutional access method is configured, ZotFetch now shows a clear alert listing affected titles with actionable next-steps (configure proxy / run Retry Failed on VPN).
- **Fix**: SemanticScholar API User-Agent now reports the current plugin version (`ZotFetch/1.4.3`) instead of a hardcoded stale string.

### v1.4.2 — VPN / native-doi fix
- **Fix**: `NativeDoiSourceResolver` was unconditionally skipping protected publishers (Elsevier, Wiley, Springer, ACS), which prevented downloads on VPN even when institutional access was active. The early-abort guard is now correctly limited to `NativeSourceResolver` (Zotero's built-in OA finder), which reports itself with Zotero's real UA.

### v1.4.1 — Elsevier captcha cascade fix
- **Fix**: Elsevier `nopdf` results (article not in the subscribed collection) no longer trigger a domain captcha cooldown. The cascade that was blocking subsequent items in the same batch from any Elsevier-hosted source has been resolved.
- **Fix**: `ScienceDirect` publisher routing improved — publisher-pattern resolver correctly handles linkinghub.elsevier.com redirect targets.

### v1.4.0 — Graphical preferences, captcha protection, UA refresh
- **New**: Graphical **Preferences dialog** (`Tools → ZotFetch → Preferences` or right-click submenu). All settings configurable in a clean UI — no `about:config` required.
- **New**: **? Help** button in the Preferences dialog opens the [User Manual wiki](https://github.com/fdossi/zotfetch/wiki).
- **New**: Cross-item domain cooldown — the first captcha from a publisher during a batch blocks all subsequent items from hitting that same publisher in the same run.
- **New**: `NativeSourceResolver` and `NativeDoiSourceResolver` now skip known bot-detection publishers (Elsevier, Wiley, Springer, ACS) entirely — preventing Zotero's native UA from triggering captcha floods.
- **New**: `native-doi` sentinel now checks `negativeCache` and `_localHostAborts` before firing, preventing redundant requests.
- **Removed**: Sci-Hub integration removed from the plugin entirely.
- **Fix**: `OaRepositorySourceResolver` tests corrected to use `itemUrl` identifier key.
- **Updated**: Browser User-Agent strings refreshed — Chrome 132→135, Edge 132→135, Firefox 135→136, Safari 17→18.
- **License**: Changed from GPLv3 to MIT.
- **Author**: Updated author from "Fabio" to "Fabio Dossi".

### v1.3.0 (2026-04-05) — Pipeline refactoring
- **Breaking internal change**: Discovery and import are now decoupled. `fetchPDF()` is a thin compatibility wrapper; the real work is done by `SourceResolver → PDFResolver → AttachmentImporter`.
- New modules: `identifiers.mjs`, `source-resolvers.mjs`, `pdf-resolvers.mjs`, `importer.mjs`
- New `IdentifierExtractor` scans DOI field, URL field, Extra field, archiveID, and DOI-in-URL patterns
- New `HtmlLandingPDFResolver` correctly extracts PDF links from publisher landing pages using `responseType: "document"` + DOM parsing. Strategies: `citation_pdf_url` meta, `<link rel="alternate">`, `<iframe>`/`<embed>`, and PDF anchors
- New `PublisherPatternResolver` with host-specific DOM rules for: Springer, Nature, Wiley, Taylor & Francis, ACS, IEEE, MDPI, Frontiers, Elsevier/ScienceDirect, SciELO.br
- `InstitutionalProxySourceResolver` now also routes Semantic Scholar PDF URLs through the proxy
- New `DoiLandingSourceResolver` for explicit DOI landing page resolution
- `requestTimeoutMs` preference added (`extensions.zotfetch.requestTimeoutMs`, default 15 000 ms)
- All failure reasons now logged with structured context (source, host, method, elapsed ms)
- `tests/pipeline.test.mjs` added covering 20+ scenarios

### v1.2.0 (2026-03-21)
- All menu items consolidated under a single **ZotFetch ▶** submenu
- Separators added between download actions, retry actions, and preferences

### v1.1.0 (2026-03-19)
- Added institutional proxy support with 4 URL pattern formats
- Fast Mode and Ultra Fast Mode with two-pass download strategy
- Live color-coded progress display
- Retry Failed Items and Retry After Auth commands
- Failure classification pipeline
- Per-domain adaptive backoff
- DOI lookup via CrossRef

### v1.0.0
- Initial release: Native OA, Unpaywall, CAPES fallback
