// chrome/content/protected-hosts.mjs
// Protected-host policies, negative cache, per-item attempt limiting, and
// enhanced challenge-page detection for publishers that aggressively challenge
// automated requests (ScienceDirect/Elsevier, Wiley, Springer, etc.).
//
// This module is purely data/logic — no imports required.
// All other modules consume it via the shared loadSubScript scope.

// ─── Policy Table ─────────────────────────────────────────────────────────
//
// allowHead              false = never issue HEAD to this host
// maxAttemptsPerItem     stop after N candidates attempted per item (per batch)
// earlyAbortOnChallenge  on captcha/auth/blocked: mark host as exhausted for
//                        this item and skip any remaining candidates for it
// retryOnCaptcha         false = don't schedule automatic retry after captcha
// negativeCacheTtlMs     session-level block duration after captcha/blocked (ms)
// negativeCacheTtlAuthMs session-level block duration after auth-wall events (ms)
// minGapMs               minimum ms between requests; used when applying a
//                        penalty cooldown after a challenge is detected

const _PROTECTED_POLICIES = {
  "sciencedirect.com": {
    allowHead:              false,
    maxAttemptsPerItem:     1,
    earlyAbortOnChallenge:  true,
    retryOnCaptcha:         false,
    negativeCacheTtlMs:     6 * 60 * 60 * 1000,   // 6 h
    negativeCacheTtlAuthMs: 45 * 60 * 1000,        // 45 min
    minGapMs:               8000
  },
  "linkinghub.elsevier.com": {
    allowHead:              false,
    maxAttemptsPerItem:     1,
    earlyAbortOnChallenge:  true,
    retryOnCaptcha:         false,
    negativeCacheTtlMs:     6 * 60 * 60 * 1000,
    negativeCacheTtlAuthMs: 45 * 60 * 1000,
    minGapMs:               6000
  },
  "elsevier.com": {
    allowHead:              false,
    maxAttemptsPerItem:     1,
    earlyAbortOnChallenge:  true,
    retryOnCaptcha:         false,
    negativeCacheTtlMs:     4 * 60 * 60 * 1000,
    negativeCacheTtlAuthMs: 30 * 60 * 1000,
    minGapMs:               6000
  },
  "onlinelibrary.wiley.com": {
    allowHead:              false,
    maxAttemptsPerItem:     1,
    earlyAbortOnChallenge:  true,
    retryOnCaptcha:         false,
    negativeCacheTtlMs:     3 * 60 * 60 * 1000,
    negativeCacheTtlAuthMs: 30 * 60 * 1000,
    minGapMs:               5000
  },
  "link.springer.com": {
    allowHead:              false,
    maxAttemptsPerItem:     2,
    earlyAbortOnChallenge:  true,
    retryOnCaptcha:         false,
    negativeCacheTtlMs:     2 * 60 * 60 * 1000,
    negativeCacheTtlAuthMs: 20 * 60 * 1000,
    minGapMs:               4000
  },
  "pubs.acs.org": {
    allowHead:              false,
    maxAttemptsPerItem:     2,
    earlyAbortOnChallenge:  true,
    retryOnCaptcha:         false,
    negativeCacheTtlMs:     2 * 60 * 60 * 1000,
    negativeCacheTtlAuthMs: 20 * 60 * 1000,
    minGapMs:               4000
  }
};

/**
 * Returns the protected-host policy for a domain (including subdomain match),
 * or null if the domain is not a protected host.
 * @param {string} domain  lowercase hostname
 * @returns {object|null}
 */
function getHostPolicy(domain) {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (_PROTECTED_POLICIES[d]) return _PROTECTED_POLICIES[d];
  for (const [host, policy] of Object.entries(_PROTECTED_POLICIES)) {
    if (d === host || d.endsWith("." + host)) return policy;
  }
  return null;
}

/**
 * Returns true if the domain has a protected-host policy.
 * @param {string} domain
 * @returns {boolean}
 */
function isProtectedHost(domain) {
  return getHostPolicy(domain) !== null;
}

// ─── Challenge Page Detection (DOM) ──────────────────────────────────────
// Inspect a parsed DOM document for challenge / captcha / auth-wall
// indicators.  Called BEFORE attempting any PDF extraction so that HTTP 200
// challenge pages are classified correctly instead of returning "nopdf".

/**
 * Detect whether a DOM document represents a challenge/captcha/auth-wall page.
 * Returns the failure reason ("captcha"|"auth"|"blocked") or null.
 * @param {Document} doc
 * @returns {"captcha"|"auth"|"blocked"|null}
 */
function detectChallengeInDoc(doc) {
  if (!doc) return null;

  // ── DOM element checks (no serialisation needed) ────────────────────────
  // Cloudflare challenge form
  if (doc.querySelector(
    "form#challenge-form, input[name='jschl_vc'], input[name='jschl_answer'], #cf-challenge-running"
  )) return "captcha";

  // reCAPTCHA
  if (doc.querySelector(
    ".g-recaptcha, #recaptcha, div[class*='recaptcha'], " +
    "script[src*='google.com/recaptcha'], script[src*='gstatic.com/recaptcha']"
  )) return "captcha";

  // hCaptcha
  if (doc.querySelector(
    ".h-captcha, div[class*='hcaptcha'], script[src*='hcaptcha.com']"
  )) return "captcha";

  // Cloudflare Turnstile
  if (doc.querySelector(
    "div[class*='cf-turnstile'], script[src*='challenges.cloudflare.com']"
  )) return "captcha";

  // ── Script src / inline script checks ─────────────────────────────────
  const scripts = Array.from(doc.querySelectorAll("script"));
  for (const s of scripts) {
    const src  = (s.getAttribute("src") || "").toLowerCase();
    const text = s.textContent || "";

    // Cloudflare & Turnstile loaders
    if (src.includes("cloudflare") || src.includes("turnstile") ||
        src.includes("challenge-platform")) return "captcha";

    // Akamai Bot Manager markers
    if (src.includes("bmak") ||
        text.includes("_abck") || text.includes("bmak.js") || text.includes("ak_bmsc")) {
      return "captcha";
    }

    // Cloudflare inline variables
    if (text.includes("cf_chl") || text.includes("jschl_vc") ||
        text.includes("__cf_bm") || text.includes("chl-challenge")) {
      return "captcha";
    }
  }

  // ── Body text / page title checks ────────────────────────────────────
  const title    = (doc.title || "").toLowerCase();
  const bodyText = (doc.body?.textContent || "").toLowerCase();

  // Page title bot-challenge signals
  if (title === "access denied" || title.includes("attention required") ||
      title.includes("just a moment") || title.includes("security check") ||
      title.includes("blocked")) {
    return "blocked";
  }

  // Bot / challenge body text
  if (bodyText.includes("please verify you are a human") ||
      bodyText.includes("checking if the site connection is secure") ||
      bodyText.includes("enable javascript and cookies to continue") ||
      bodyText.includes("unusual traffic from your computer") ||
      bodyText.includes("automated access") ||
      bodyText.includes("bot or a human")) {
    return "captcha";
  }

  // Hard block / rate-limit body text
  if (bodyText.includes("you have been blocked") ||
      bodyText.includes("your access to this service has been") ||
      bodyText.includes("access has been blocked") ||
      bodyText.includes("ip address has been blocked")) {
    return "blocked";
  }

  // Subscription / auth wall
  if (bodyText.includes("purchase this article") ||
      bodyText.includes("buy this article") ||
      bodyText.includes("purchase access") ||
      bodyText.includes("subscribe to access") ||
      bodyText.includes("unlock full access") ||
      bodyText.includes("this article requires a subscription") ||
      bodyText.includes("full text available to subscribers") ||
      bodyText.includes("access through your institution") ||
      bodyText.includes("you do not have access to this content") ||
      bodyText.includes("get access to the full")) {
    return "auth";
  }

  // Login / SSO redirect
  if (bodyText.includes("log in to access") ||
      bodyText.includes("sign in to access this article") ||
      bodyText.includes("institutional login required") ||
      bodyText.includes("please log in to continue") ||
      bodyText.includes("sign in to view full")) {
    return "auth";
  }

  return null;
}

// ─── Challenge Page Detection (plain text) ───────────────────────────────
// Used by DirectPDFResolver which receives responseText (not a DOM).

/**
 * Detect challenge/auth/block in a plain HTML string.
 * @param {string} text
 * @returns {"captcha"|"auth"|"blocked"|null}
 */
function detectChallengeInText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  if (lower.includes("cf_chl") || lower.includes("jschl_vc") ||
      lower.includes("__cf_bm") || lower.includes("_abck") ||
      lower.includes("bmak.js") || lower.includes("turnstile") ||
      lower.includes("g-recaptcha") || lower.includes("h-captcha") ||
      lower.includes("please verify you are a human") ||
      lower.includes("checking if the site connection is secure") ||
      lower.includes("enable javascript and cookies to continue") ||
      lower.includes("unusual traffic from your computer")) {
    return "captcha";
  }

  if (lower.includes("you have been blocked") ||
      lower.includes("access has been blocked") ||
      lower.includes("ip address has been blocked")) {
    return "blocked";
  }

  if (lower.includes("purchase this article") ||
      lower.includes("subscribe to access") ||
      lower.includes("unlock full access") ||
      lower.includes("log in to access") ||
      lower.includes("sign in to access this article") ||
      lower.includes("access through your institution") ||
      lower.includes("you do not have access to this content")) {
    return "auth";
  }

  return null;
}

// ─── Elsevier / ScienceDirect PDF URL Patterns ───────────────────────────
// Elsevier PDF download URLs often don't end in .pdf, so the standard
// extension heuristic falsely rejects valid authenticated URLs.

const _ELSEVIER_PDF_RX = [
  /sciencedirect\.com.*\/pdfft(\?|$)/i,
  /sciencedirect\.com.*\/pdf\//i,
  /pdf\.sciencedirect\.com/i,
  /els-cdn\.com.*\.pdf/i
];

/**
 * Returns true if the URL is a known Elsevier/ScienceDirect direct-PDF
 * download link even if it does not end in ".pdf".
 * @param {string} url
 * @returns {boolean}
 */
function looksLikeElsevierPdfUrl(url) {
  if (!url) return false;
  return _ELSEVIER_PDF_RX.some(rx => rx.test(url));
}

// ─── Negative Cache ──────────────────────────────────────────────────────
// Session-level block for (doi, publisher-host) pairs after a challenge
// event.  Entries expire after the per-host policy TTL but are not persisted
// across Zotero restarts.

class ProtectedHostNegativeCache {
  constructor() {
    this._cache = new Map(); // key → { reason, expiresAt }
  }

  _key(doi, host) {
    return `${String(doi || "").toLowerCase()}::${String(host || "").toLowerCase()}`;
  }

  /**
   * Add a (doi, host) block.
   * @param {string}      doi
   * @param {string}      host    canonical protected publisher hostname
   * @param {string}      reason  "captcha"|"auth"|"blocked"
   * @param {object|null} policy  host policy (for TTL lookup)
   */
  add(doi, host, reason, policy) {
    if (!host) return;
    const ttl = (reason === "auth")
      ? (policy?.negativeCacheTtlAuthMs ?? 45 * 60 * 1000)
      : (policy?.negativeCacheTtlMs    ?? 6 * 60 * 60 * 1000);
    this._cache.set(this._key(doi, host), { reason, expiresAt: Date.now() + ttl });
    Zotero.debug(
      `[ZotFetch][NegCache] Block +${Math.round(ttl / 60000)} min — ` +
      `doi=${doi || "?"} host=${host} reason=${reason}`
    );
  }

  /**
   * Returns true if (doi, host) is currently blocked.
   * @param {string} doi
   * @param {string} host
   * @returns {boolean}
   */
  has(doi, host) {
    const key   = this._key(doi, host);
    const entry = this._cache.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) { this._cache.delete(key); return false; }
    return true;
  }

  /** Returns the cached entry or null. */
  get(doi, host) {
    const key   = this._key(doi, host);
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { this._cache.delete(key); return null; }
    return entry;
  }

  clear() { this._cache.clear(); }
  get size() { return this._cache.size; }
}

// ─── Per-Batch Item + Host Attempt Tracker ───────────────────────────────
// Tracks how many candidates have been attempted per (itemKey, publisher-host)
// within the current batch run.  Cleared at the start of each runBatch() call.
// Prevents a single item from generating many requests to the same publisher.

class ItemHostAttemptTracker {
  constructor() {
    this._map = new Map(); // "itemKey::host" → count
  }

  _key(itemKey, host) {
    return `${String(itemKey || "")}::${String(host || "").toLowerCase()}`;
  }

  /** Increment and return the new attempt count. */
  increment(itemKey, host) {
    const k = this._key(itemKey, host);
    const n = (this._map.get(k) || 0) + 1;
    this._map.set(k, n);
    return n;
  }

  get(itemKey, host) {
    return this._map.get(this._key(itemKey, host)) || 0;
  }

  clear() { this._map.clear(); }
}

this.ProtectedHosts = {
  getHostPolicy,
  isProtectedHost,
  detectChallengeInDoc,
  detectChallengeInText,
  looksLikeElsevierPdfUrl,
  ProtectedHostNegativeCache,
  ItemHostAttemptTracker
};
