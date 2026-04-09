# ZotFetch: Download PDFs for Your Entire Zotero Library in One Click

*Posted by Fabio Dossi — April 2026*

---

If you use Zotero to manage a large research library, you've probably faced this: hundreds of items, most of them missing their PDF. Filling them in one by one — opening DOI links, clicking through publisher pages, dragging files into Zotero — takes hours. **ZotFetch** is a Zotero 8 plugin that does this automatically, in bulk, while you go make coffee.

## What it does

Select any number of items in your library (you can select your entire collection if you want), right-click, hover over **ZotFetch ▶**, and click **Batch Download**. A progress window opens and the plugin starts working through them:

```
PDFs 12/87 (13%) · 🟢 Semantic Scholar · "Protein folding…"
PDFs 13/87 (15%) · 🔵 Unpaywall · "Climate tipping points…"
PDFs 14/87 (16%) · 🟡 Not found · "JSTOR exclusive…"
```

For each item, ZotFetch queries a priority-ordered list of open-access sources, then your institutional proxy if one is configured, and finally the CAPES portal if you're at a Brazilian institution. It finds the real PDF URL — not a landing page — and imports it directly into the item, just as if you had done it manually.

## Sources it checks

ZotFetch works through sources in order of reliability and access:

1. **Zotero's own OA finder** (Native OA, via Unpaywall/OA Button)
2. **Unpaywall** — the gold standard for legal OA lookups
3. **Semantic Scholar** — often has OA PDFs for CS and biomedical literature
4. **OpenAlex** — broad coverage of `best_oa_location`
5. **Europe PMC** — strong for biomedical papers with a PMID
6. **CORE** — 234 million+ records from global institutional repositories
7. **OA Repository** — the item's own URL if it points to arXiv, Zenodo, bioRxiv, HAL, PubMed Central, etc.
8. **DOI Landing** + publisher HTML parsing (Springer, Nature, Wiley, Elsevier, ACS, IEEE, MDPI, Frontiers, Taylor & Francis, SciELO.br)
9. **Institutional Proxy** (EZproxy, OpenAthens, or any proxy URL you configure)
10. **CAPES Portal** (Brazil)

If a source returns a publisher landing page rather than a direct PDF link, ZotFetch parses the HTML using publisher-specific rules and a generic extractor (`citation_pdf_url` meta tag, `<link rel="alternate">`, iframes, embed elements, PDF anchors) to find the real file before importing.

## Smart rate limiting and captcha protection

Running bulk requests against publisher servers can trigger bot-detection responses. ZotFetch handles this carefully:

- It spaces requests with configurable per-domain minimum gaps (default: 1.5 s) and randomised jitter.
- Publishers known to aggressively challenge automated requests (Elsevier, Wiley, Springer, ACS) are automatically excluded from the Zotero-native resolver paths — ZotFetch uses spoofed browser headers for those instead.
- If a captcha appears during a batch, ZotFetch records it. After the first captcha from a given domain, all remaining items skip that publisher for the rest of the run. After 3, the domain is blocked for 30 minutes.
- When a captcha *does* block an item, **Retry After Auth** opens the publisher URL in your browser so you can solve it, then retries automatically.

## Fast Mode and Ultra Fast Mode

- **Fast Mode** (default): Two-pass strategy. Open-access sources run first; only unresolved items proceed to the institutional/CAPES fallback pass. Most items resolve in Pass 1, keeping institutional connections quiet and fast.
- **Ultra Fast Mode**: Single pass, maximum speed, OA sources only. Great for a first sweep of a large collection before a more thorough run.

## Institutional access

If you're at a university with an EZproxy or similar authentication gateway, paste the proxy URL into the Preferences dialog once, and ZotFetch will automatically route every DOI through it. Supports `?url=`, `?qurl=`, `{url}` template, and bare base URL formats. If you're at a Brazilian institution with CAPES access, there's a dedicated toggle and gateway URL field.

## Getting it

- **GitHub**: [https://github.com/fdossi/zotfetch](https://github.com/fdossi/zotfetch)
- **Download**: grab the latest `.xpi` from the [Releases page](https://github.com/fdossi/zotfetch/releases)
- **Install**: Zotero → Tools → Add-ons → ⚙ → Install Add-on From File…
- **DOI**: [10.5281/zenodo.19149482](https://doi.org/10.5281/zenodo.19149482)

Requires **Zotero 8.0.4** or later. Released under the **MIT License**.

The [User Manual](https://github.com/fdossi/zotfetch/wiki) has step-by-step setup for institutional proxy and CAPES, all settings explained, and a troubleshooting guide. A **? Help** button in the Preferences dialog links directly to it.

---

Feedback, bug reports, and pull requests are welcome on GitHub. I'd especially love to hear which publishers still slip through — the publisher-pattern resolver can always be extended.
