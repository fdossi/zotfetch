# ZotFetch: Batch PDF Downloader for Zotero

![ZotFetch banner](banner.jpg)

**ZotFetch** is a [Zotero 8](https://www.zotero.org/) plugin that automatically downloads PDFs for multiple library items in a single operation. It tries multiple sources in sequence — starting from free open-access routes — and falls back to institutional proxies and other repositories when needed.

---

## Features

- **Multi-source download pipeline**: Native OA → Unpaywall → Institutional Proxy → Sci-Hub → CAPES/DOI proxy
- **Fast Mode**: Two-pass strategy — lightweight sources first, heavy fallbacks only for unresolved items
- **Ultra Fast Mode**: Single-pass, maximum speed, OA-only with one Sci-Hub fallback
- **Adaptive rate limiting**: Per-domain request spacing with exponential backoff on failures
- **Anti-captcha protection**: Tracks consecutive captcha hits per domain; blocks domain after 3 consecutive hits, resets on success
- **DOI lookup**: Automatically resolves missing DOIs via CrossRef before attempting downloads
- **Retry Failed Items**: Re-runs only the items that failed in the last batch
- **Retry After Auth**: Opens DOI URLs in your browser for manual authentication, then retries captcha/auth-blocked items
- **Live progress**: Color-coded status (🔵 warmup / 🟢 good / 🟡 moderate / 🔴 poor) with `PDFs X/Y (Z%)` counter
- **Institutional proxy support**: Configurable proxy URL for legal access to paywalled content

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

This creates `zotfetch-1.2.0.xpi`. Install it via the steps above.

---

## Usage

Select one or more items in your Zotero library, then right-click and hover over **ZotFetch ▶** to open the submenu:

| Command | Description |
|---|---|
| **Batch Download** | Downloads PDFs for all selected items using all sources (two-pass if Fast Mode is on) |
| **Ultra Fast** | Single-pass, fastest mode — OA sources + one Sci-Hub mirror. May download fewer PDFs. |
| **Retry Failed** | Re-attempts only items that failed in the most recent batch |
| **Retry After Auth** | Opens up to 3 DOI URLs in your browser for manual login/captcha, then retries blocked items |
| **Preferences** | Shows current configuration values |

---

## Download Sources

ZotFetch tries sources in this order for each item:

1. **Native OA** — Zotero's built-in open-access finder (`addAvailableFile`)
2. **Unpaywall** — Free legal OA PDF lookup via [Unpaywall API](https://unpaywall.org/) (requires a registered email)
3. **Institutional Proxy** — Your institution's EZproxy or similar (configurable URL)
4. **Sci-Hub** — 7 mirrors tried in reliability order; mirror count is limited by `fastMirrorLimit` in fallback pass
5. **CAPES/DOI proxy** — Brazilian CAPES portal or a custom DOI proxy URL

In **Fast Mode**, sources 1–3 run in Pass 1. Only unresolved items proceed to Pass 2 (sources 4–5). In **Ultra Fast Mode**, only sources 1–3 plus one Sci-Hub mirror are used in a single pass.

---

## Configuration

View current settings at any time via **ZotFetch ▶ Preferences** in the right-click menu.

To change settings, edit them directly in **`about:config`** (Zotero's advanced config editor, accessible via **Edit → Settings → Advanced → Config Editor**), filtering by `extensions.zotfetch`.

| Preference key | Default | Description |
|---|---|---|
| `extensions.zotfetch.unpaywallEmail` | _(empty)_ | Your email for Unpaywall API access. **Required** for Unpaywall to work. |
| `extensions.zotfetch.institutionalProxyUrl` | _(empty)_ | Your institution's proxy URL, e.g. `https://proxy.myuniversity.edu/login?url=` |
| `extensions.zotfetch.fastMode` | `true` | Enables two-pass Fast Mode |
| `extensions.zotfetch.fastMirrorLimit` | `2` | Max Sci-Hub mirrors to try in the fallback pass |
| `extensions.zotfetch.batchSize` | `30` | Max items to process per batch run |
| `extensions.zotfetch.requestDelayMs` | `900` | Base delay between requests (ms), ±30% jitter applied |
| `extensions.zotfetch.domainGapMs` | `1500` | Minimum gap between requests to the same domain (ms) |
| `extensions.zotfetch.antiCaptchaMode` | `true` | Skip domains that are currently in cooldown |
| `extensions.zotfetch.enableScihubFallback` | `true` | Enable Sci-Hub as a fallback source |
| `extensions.zotfetch.enableCapesFallback` | `true` | Enable CAPES/DOI proxy as a fallback source |
| `extensions.zotfetch.proxyUrl` | _(empty)_ | CAPES or generic DOI proxy URL |
| `extensions.zotfetch.unpaywallTimeoutMs` | `12000` | Timeout for Unpaywall API requests (ms) |
| `extensions.zotfetch.crossrefTimeoutMs` | `10000` | Timeout for CrossRef DOI lookup (ms) |

### Institutional proxy URL formats

ZotFetch supports all common proxy URL patterns:

| Format | Example |
|---|---|
| Template placeholder | `https://proxy.myuniv.edu/login?url={url}` |
| Direct query parameter | `https://proxy.myuniv.edu/?url=` |
| Query string | `https://proxy.myuniv.edu/proxy?url=` |
| EZproxy bare base | `https://proxy.myuniv.edu` |

---

## How Anti-Captcha and Rate Limiting Work

ZotFetch tracks request history per domain:

- **Domain gap**: Waits at least `domainGapMs` milliseconds between requests to the same domain
- **Adaptive backoff**: On consecutive non-captcha failures, adds exponential extra wait per domain (first +1 s, then +2 s, +4 s… capped at +15 s). Resets on any success.
- **Captcha threshold**: After 3 consecutive captcha responses from the same domain, that domain is blocked for 30 minutes
- **Failure classification**: Errors are classified as `captcha`, `auth` (403/401), `blocked` (429/rate-limit), `timeout`, `nopdf` (404), or `network`. Each class triggers different cooldown behavior.

---

## Requirements

- **Zotero 8.0.4** or later (not compatible with Zotero 7 or earlier)
- A registered email address for [Unpaywall](https://unpaywall.org/) (free, no sign-up required — just a valid email in the preferences)

---

## Known Limitations

- **Captcha-blocked sessions**: When a publisher serves a captcha to the plugin's HTTP client, the plugin cannot solve it. Use **ZotFetch ▶ Retry After Auth** to open the URL in your browser, solve the captcha manually, then retry.
- **Paywalled publishers without proxy**: Without an institutional proxy configured, ZotFetch can only find freely available (OA) versions of paywalled articles.
- **Sci-Hub availability**: Sci-Hub mirror availability varies by region and time. If all mirrors fail, configure more mirrors via `fastMirrorLimit` or retry later.

---

## License

Released under the [GNU General Public License v3.0](LICENSE).

Contributions via pull requests are welcome.

---

## Changelog

### v1.2.0 (2026-03-21)
- All menu items consolidated under a single **ZotFetch ▶** submenu in the right-click context menu
- Separators added between download actions, retry actions, and preferences

### v1.1.0 (2026-03-19)
- Added institutional proxy support with 4 URL pattern formats
- Fast Mode and Ultra Fast Mode with two-pass download strategy
- Live color-coded progress display
- Retry Failed Items and Retry After Auth commands
- Failure classification pipeline (captcha / auth / blocked / timeout / nopdf / network)
- Per-domain adaptive backoff with exponential extra delay on failures
- DOI lookup via CrossRef for items missing a DOI
- Expanded to 7 Sci-Hub mirrors ordered by reliability
- Fixed diacritic normalization in title similarity matching
- Fixed `hasPDF` missing `await` causing incorrect domain success tracking
- Removed `encodeURIComponent` on Sci-Hub DOI path (broke most mirrors)
- Dead prefs (`maxRetries`, `exportStats`) removed

### v1.0.0
- Initial release: Native OA, Unpaywall, Sci-Hub, CAPES fallback
- Anti-captcha consecutive counter with 30-minute domain cooldown

