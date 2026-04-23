// chrome/content/utils.mjs
// Shared utilities: DOI, similarity, validation, stealth fingerprinting

const BROWSER_FINGERPRINTS = [
  {
    // Chrome 135 / Windows (most common)
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="99"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"'
  },
  {
    // Edge 135 / Windows
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
    secChUa: '"Chromium";v="135", "Microsoft Edge";v="135", "Not-A.Brand";v="99"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"'
  },
  {
    // Chrome 135 / macOS
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="99"',
    secChUaMobile: "?0",
    secChUaPlatform: '"macOS"'
  },
  {
    // Firefox 136 / Windows — does not send Client Hints
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
    secChUa: null,
    secChUaMobile: null,
    secChUaPlatform: null
  },
  {
    // Safari 18 / macOS — does not send Client Hints
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    secChUa: null,
    secChUaMobile: null,
    secChUaPlatform: null
  },
  {
    // Chrome 134 / Windows (slightly older)
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="134", "Google Chrome";v="134", "Not-A.Brand";v="99"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"'
  },
  {
    // Chrome 135 / Linux
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="99"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Linux"'
  },
  {
    // Mobile Chrome / Android
    userAgent: "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
    secChUa: '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="99"',
    secChUaMobile: "?1",
    secChUaPlatform: '"Android"'
  }
];

var Utils = {
  normalizeDOI(doi) {
    return String(doi || '').trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '')
      .trim();
  },

  isTitleSimilar(titleA, titleB) {
    const normalize = (s) => String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[\-\u2013\u2014]/g, ' ')
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .filter(w => w.length >= 4);

    const wordsA = new Set(normalize(titleA));
    const wordsB = new Set(normalize(titleB));
    if (!wordsA.size || !wordsB.size) return { match: false, score: 0 };

    let overlap = 0;
    for (const w of wordsA) if (wordsB.has(w)) overlap++;
    const union = wordsA.size + wordsB.size - overlap;
    const score = union > 0 ? overlap / union : 0;

    const minWords = Math.min(wordsA.size, wordsB.size);
    const threshold = minWords <= 3 ? 0.80 : minWords <= 6 ? 0.65 : 0.60;
    return { match: score >= threshold, score };
  },

  isValidEmail(email) {
    return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  },

  getDomain(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      const match = String(url).match(/^https?:\/\/([^\/]+)/i);
      return match ? match[1] : '';
    }
  },

  isCaptchaError(error) {
    const text = String(error?.message || error || '').toLowerCase();
    return text.includes('captcha') || text.includes('robot') ||
           text.includes('cloudflare') || text.includes('cf-challenge') ||
           text.includes('cf_chl') || text.includes('turnstile') ||
           text.includes('ray id');
  },

  // Returns a randomised headers object with a modern browser fingerprint.
  // Enhanced for bypassing aggressive bot detection like Elsevier captchas.
  // Includes realistic headers that mimic human browsing behavior.
  getStealthHeaders(options = {}) {
    const fp = BROWSER_FINGERPRINTS[Math.floor(Math.random() * BROWSER_FINGERPRINTS.length)];

    // Common Accept-Language combinations to look more human
    const acceptLanguages = [
      "en-US,en;q=0.9",
      "en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7",
      "en-GB,en;q=0.9",
      "en-US,en;q=0.9,de;q=0.8",
      "en-US,en;q=0.9,es;q=0.8"
    ];

    // Vary sec-fetch-* headers to avoid pattern detection
    const fetchModes = ["navigate", "cors", "no-cors"];
    const fetchSites = ["none", "cross-site", "same-origin", "same-site"];

    const headers = {
      "User-Agent": fp.userAgent,
      "Accept": options.isPdf ? "application/pdf,*/*;q=0.8" : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Language": acceptLanguages[Math.floor(Math.random() * acceptLanguages.length)],
      "Accept-Encoding": "gzip, deflate, br",
      "DNT": "1",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": options.isPdf ? "document" : "document",
      "Sec-Fetch-Mode": fetchModes[Math.floor(Math.random() * fetchModes.length)],
      "Sec-Fetch-Site": fetchSites[Math.floor(Math.random() * fetchSites.length)],
      "Sec-Fetch-User": options.isNavigation ? "?1" : undefined,
      "Cache-Control": "max-age=0",
      "sec-ch-ua": fp.secChUa || undefined,
      "sec-ch-ua-mobile": fp.secChUaMobile || undefined,
      "sec-ch-ua-platform": fp.secChUaPlatform || undefined
    };

    // Remove undefined headers
    Object.keys(headers).forEach(key => {
      if (headers[key] === undefined) {
        delete headers[key];
      }
    });

    return headers;
  },

  // Returns a randomized delay to simulate human browsing behavior
  getHumanDelayMs(minMs = 1000, maxMs = 3000) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  },

  // Enhanced stealth headers specifically for challenging sites like Elsevier
  getAggressiveStealthHeaders(options = {}) {
    const baseHeaders = this.getStealthHeaders(options);

    // Add additional headers that make requests look more human
    const aggressiveHeaders = {
      ...baseHeaders,
      "sec-ch-ua-arch": '"x86"',  // Architecture hint
      "sec-ch-ua-bitness": '"64"', // Bitness hint
      "sec-ch-ua-full-version": options.uaVersion || '"135.0.0.0"',
      "sec-ch-ua-full-version-list": options.uaVersionList || '"Chromium";v="135.0.0.0", "Google Chrome";v="135.0.0.0", "Not-A.Brand";v="99.0.0.0"',
      "sec-ch-ua-model": '""',   // Empty for desktop
      "sec-ch-ua-platform-version": '"10.0.0"', // Windows version
      "sec-fetch-dest": options.isPdf ? "document" : "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "sec-purpose": "prefetch", // Sometimes used for navigation
      "priority": "u=0, i",     // Priority hint
      "pragma": "no-cache",
      "te": "trailers"          // Transfer encoding
    };

    // Remove undefined headers
    Object.keys(aggressiveHeaders).forEach(key => {
      if (aggressiveHeaders[key] === undefined) {
        delete aggressiveHeaders[key];
      }
    });

    return aggressiveHeaders;
  },

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};

this.Utils = Utils;

