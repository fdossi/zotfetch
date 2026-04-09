# ZotFetch — User Manual

**ZotFetch** is a Zotero 8 plugin that automatically downloads PDFs for entire library selections using a smart multi-source pipeline. This manual covers everything you need to start downloading PDFs and configuring institutional access.

> **Version:** 1.4.0 · **Author:** Fabio Dossi · **License:** MIT  
> **Repository:** https://github.com/fdossi/zotfetch

---

## Table of Contents

1. [Installation](#1-installation)
2. [Quick Start](#2-quick-start)
3. [Menu Commands](#3-menu-commands)
4. [Download Modes](#4-download-modes)
5. [How ZotFetch Finds PDFs](#5-how-zotfetch-finds-pdfs)
6. [Setting Up Institutional Access](#6-setting-up-institutional-access)
   - [Preferences Dialog](#61-opening-the-preferences-dialog)
   - [University / EZproxy](#62-university--ezproxy-institutional-proxy)
   - [CAPES Portal (Brazil)](#63-capes-portal-brazil)
7. [All Settings Reference](#7-all-settings-reference)
8. [Dealing with Captchas](#8-dealing-with-captchas)
9. [Tips & Troubleshooting](#9-tips--troubleshooting)

---

## 1. Installation

1. Download `zotfetch-1.4.0.xpi` from the [Releases page](https://github.com/fdossi/zotfetch/releases/latest).
2. In Zotero: **Tools → Add-ons → ⚙ → Install Add-on From File…**
3. Select the downloaded `.xpi` file and click **Open**.
4. Zotero will prompt for a restart — click **Restart Now**.

Zotero automatically checks for updates. When a new version is released, Zotero will offer to install it.

---

## 2. Quick Start

1. Open Zotero and navigate to any library collection.
2. Select one or more items that are missing PDFs (you can select hundreds at once).
3. **Right-click** the selection → hover over **ZotFetch ▶**.
4. Click **Batch Download**.
5. Watch the progress window — it shows live counts like `PDFs 12/30 (40%)`.

That's it. ZotFetch will try every available source automatically and import each PDF directly into the item.

---

## 3. Menu Commands

Access all commands via **right-click → ZotFetch ▶**:

| Command | What it does |
|---|---|
| **Batch Download** | Main command. Tries all OA sources first, then institutional proxy and CAPES as fallback (when Fast Mode is on). |
| **Ultra Fast** | Single-pass, maximum speed. Uses open-access sources only. Skips CAPES fallback. |
| **Retry Failed** | Re-processes only items that failed in the most recent batch. |
| **Retry After Auth** | Opens the DOI URLs of blocked/captcha items in your browser so you can authenticate, then retries those items. |
| **Preferences** | Opens the graphical settings dialog where you configure proxy, CAPES, email, and other options. |

---

## 4. Download Modes

### Fast Mode (default — recommended)

Two-pass strategy:

- **Pass 1** — tries all open-access sources (Zotero Native OA, Unpaywall, Semantic Scholar, OpenAlex, Europe PMC, CORE, OA Repository, DOI Landing, Institutional Proxy).
- **Pass 2** — runs only for items that failed Pass 1, using CAPES.

**Result:** Most items are resolved in Pass 1 using safe OA sources. Only genuinely paywalled items hit CAPES.

### Ultra Fast Mode

Everything runs in a single pass. CAPES is skipped. Best for quick sweeps of large collections when you want maximum speed and will retry failures later.

### Full Mode

Runs when Fast Mode is disabled, or during **Retry Failed**. All sources run in a single comprehensive pass with no deferral — CAPES is included.

---

## 5. How ZotFetch Finds PDFs

ZotFetch tries sources in priority order. As soon as one succeeds, it imports the PDF and moves on:

| Priority | Source | Description |
|---|---|---|
| 110 | **Zotero Native OA** | Zotero's built-in open-access finder (Unpaywall, OA Button, etc.). Skipped for Elsevier/Wiley/Springer to avoid captchas. |
| 100 | **Unpaywall** | Queries [unpaywall.org](https://unpaywall.org/) for legal free PDF locations. Requires email. |
| 95 | **Semantic Scholar** | Queries the S2 Graph API for an open-access PDF URL. |
| 90 | **OpenAlex** | Queries [openalex.org](https://openalex.org/) `best_oa_location`. |
| 89 | **Europe PMC** | Biomedical papers with PMID or DOI. Only returns verified OA entries. |
| 88 | **CORE** | Searches [core.ac.uk](https://core.ac.uk/) — 234M+ records from institutional repositories. |
| 85 | **OA Repository** | Uses the item's Zotero URL field if it points to a known safe OA host (arXiv, PubMed Central, Zenodo, HAL, bioRxiv, MDPI…). |
| 83 | **Zotero Native (DOI)** | Zotero's translator-based DOI resolver. Works automatically when on institutional IP/VPN. Skipped for Elsevier/Wiley/Springer. |
| 80 | **DOI Landing** | Follows `doi.org/{doi}` to the publisher page and extracts the PDF link with DOM parsing. |
| 75 | **Institutional Proxy** | Wraps the DOI URL through your configured proxy. Also routes Semantic Scholar PDF URLs through the proxy. |
| 72 | **Institutional Proxy (S2)** | S2 OA PDF URL routed through your proxy. |
| 70 | **CAPES** | CAPES Periódicos portal (Brazil). Only in Batch Download 2nd pass and Retry. |


When a source returns a **landing page** (not a direct PDF URL), ZotFetch parses the HTML using publisher-specific rules for Springer, Nature, Wiley, Taylor & Francis, ACS, IEEE, MDPI, Frontiers, Elsevier/ScienceDirect, and SciELO.br — with a generic extractor (`citation_pdf_url` meta tag, `<link rel="alternate">`, iframe/embed, PDF anchors) as a universal fallback.

---

## 6. Setting Up Institutional Access

### 6.1 Opening the Preferences Dialog

Go to **right-click → ZotFetch ▶ → Preferences**.

A graphical dialog opens with all settings. Changes take effect immediately on the next batch — no Zotero restart needed.

You can also click **? Help** in the preferences dialog to open this page.

---

### 6.2 University / EZproxy (Institutional Proxy)

This setting lets ZotFetch route PDF requests through your university's authenticated proxy server. This is the best way to download paywalled articles legally using your institution's subscriptions, and it works automatically in the background — no browser session needed.

**When does it work?**
- Your Zotero is running on the campus network (wired or Wi-Fi)
- Your Zotero is running with the institution's VPN active
- Your institution uses cookie-based EZproxy and you have an active browser session

**How to find your proxy URL:**

1. Visit your library's website and search for "off-campus access", "remote access", or "proxy".
2. Look for a URL containing words like `proxy`, `ezproxy`, `login`, or `remote`.
3. The URL should end with `?url=` or `?qurl=` — copy everything up to and including that.
4. If you see a placeholder like `{url}`, copy the entire template including `{url}`.

**Where to enter it:**

In the Preferences dialog → **Institutional Access** section → **University / Institutional Proxy URL** field.

**Supported URL formats:**

| Format | Example to paste |
|---|---|
| Ends with `?url=` | `https://proxy.uni.edu/login?url=` |
| Ends with `?qurl=` | `https://eresources.uni.edu/login?qurl=` |
| Uses `{url}` placeholder | `https://proxy.uni.edu/login?qurl={url}` |
| Bare base URL | `https://proxy.uni.edu` |

ZotFetch automatically appends the encoded target URL to whatever you paste. Example final URL:
```
https://proxy.uni.edu/login?url=https%3A%2F%2Fdoi.org%2F10.1016%2Fj.cell.2023.01.001
```

**Common institutional proxy URLs by country/system:**

| System | Common format |
|---|---|
| EZproxy (US/UK/AU) | `https://ezproxy.library.myuniversity.edu/login?url=` |
| OpenAthens | `https://go.openathens.net/redirector/myuniversity.edu?url=` |
| WAM (Australia) | `https://wam.remote.myuniversity.edu/login?url=` |
| Brazil - Rede Pergamum | `https://proxy.biblioteca.myuniversity.edu.br/login?url=` |

---

### 6.3 CAPES Portal (Brazil)

CAPES Periódicos ([periodicos.capes.gov.br](https://www.periodicos.capes.gov.br/)) provides Brazilian federal universities, state universities (depending on agreement), and federal research institutes with access to thousands of paywalled journals.

**Who can use it:**
- Students, researchers, and staff at any CAPES-affiliated institution
- Works from the institution's network or via CAFe (Comunidade Acadêmica Federada) authentication

**How to enable:**

1. Open **Preferences → Institutional Access**.
2. Check **Enable CAPES Portal**.
3. Enter your **CAPES Gateway URL** (see below).

**CAPES Gateway URL:**

Ask your institution's library for the exact URL. Common formats:

| Type | URL |
|---|---|
| CAFe federated login | `https://capes.ez.no/login?url=` |
| Institution-specific EZproxy routed through CAPES | Use the **Institutional Proxy** field instead |

If your library gave you a URL that already contains your university's name, use it in the **Institutional Proxy** field (section 6.2) — that's already routing through CAPES for you.

**When does CAPES run?**

CAPES only runs in:
- **Batch Download** — 2nd pass (after OA sources fail), when Fast Mode is on
- **Batch Download** with Fast Mode off — single full pass
- **Retry Failed** — always
- **Ultra Fast** — ❌ does **not** run

**No CAPES URL set?**

If you leave the CAPES Gateway URL blank but keep the toggle on, ZotFetch sends the `doi.org` URL directly. This works only if Zotero is running from a network that CAPES already authenticates (e.g. your institution's network with a CAPES IP agreement).

---

## 7. All Settings Reference

| Setting | Default | Description |
|---|---|---|
| **Email address** | *(empty)* | Used by Unpaywall, CrossRef, OpenAlex, EuropePMC. The plugin uses a fallback address if you leave it empty, but setting your own gives you better rate limits and support. |
| **CORE API Key** | *(empty)* | Optional. Free key from [core.ac.uk/services/api](https://core.ac.uk/services/api). Without key: ~10 req/min. With key: 10,000 req/day. |
| **Institutional Proxy URL** | *(empty)* | Your university's EZproxy/authentication URL. Activates the proxy resolver when non-empty. |
| **CAPES Gateway URL** | *(empty)* | CAPES portal gateway URL. Only used when the CAPES toggle is on. |
| **Enable CAPES Portal** | On | Enables the CAPES source resolver. |
| **Fast Mode** | On | Two-pass download strategy. Recommended. Turn off only if you want everything in one pass. |
| **Batch size** | 30 | Maximum items processed per Batch Download run. |
| **Delay between items (ms)** | 900 | Base pause between processing each item. ±60% jitter applied automatically. |
| **Domain gap (ms)** | 1500 | Minimum pause between successive requests to the same domain. |
| **Anti-Captcha Mode** | On | Skips domains currently in cooldown. Keeps the adaptive backoff system active. |
| **Request timeout (ms)** | 15000 | How long to wait for a single HTTP response before giving up. |
| **Unpaywall timeout (ms)** | 12000 | Timeout for Unpaywall API calls. |
| **CrossRef timeout (ms)** | 10000 | Timeout for CrossRef DOI lookup. |

---

## 8. Dealing with Captchas

Some publishers (mainly Elsevier/ScienceDirect, Wiley) aggressively challenge automated requests with CAPTCHA challenges.

**ZotFetch's automatic protections:**
- Publishers that are known to block automated UA strings (Elsevier, Wiley, Springer, ACS) are automatically skipped by the Zotero Native and Zotero Native DOI resolvers — ZotFetch uses spoofed browser headers for those instead.
- After the **first** captcha from a publisher in a batch, all remaining items skip that publisher for the rest of the batch (penalty cooldown).
- After 3 captchas, the domain is blocked for 30 minutes automatically.

**What to do when a captcha appears:**

1. Note which publisher is showing the captcha.
2. After the batch finishes, select the failed items.
3. Right-click → **ZotFetch ▶ → Retry After Auth**.
4. ZotFetch opens the publisher URL in your browser. Solve the captcha there.
5. Click **OK** in Zotero when done. ZotFetch retries the items.

---

## 9. Tips & Troubleshooting

**Nothing downloads — "Nenhum item elegível" message**  
All selected items already have PDFs attached. ZotFetch skips items that already have a PDF.

**Very few PDFs download, mostly "not found"**  
The items may be genuinely paywalled. Configure your Institutional Proxy (§6.2) or CAPES (§6.3), then run **Retry Failed**.

**Downloads stop after a few items**  
A publisher is probably triggering repeated captchas. Use **Retry After Auth** to solve them in the browser, then retry. Consider increasing the **Delay between items** setting.

**Proxy configured but still not downloading**  
- Confirm you're on the institution's network or VPN
- Test by opening your proxy URL manually in a browser: `https://your-proxy.edu/login?url=https://doi.org/10.1016/j.cell.2023.01.001`
- Make sure the URL format in Preferences matches one of the supported formats (§6.2)

**CAPES toggle is on but no downloads via CAPES**  
CAPES only runs in the 2nd pass (Fast Mode) or during Retry. Run **Retry Failed** after a normal batch to force CAPES to activate. Also confirm the CAPES Gateway URL is correctly set.

**Missing DOI on some items**  
ZotFetch automatically looks up missing DOIs via CrossRef using the title and author. If this fails (title too generic or not in CrossRef), add the DOI manually to the item's DOI field.

**Ultra Fast completed but many items missing**  
Expected — Ultra Fast skips CAPES. Follow up with **Batch Download** or **Retry Failed** in standard Fast Mode.
