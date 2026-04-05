// chrome/content/utils.mjs
// Shared utilities: DOI, similarity, validation, stealth fingerprinting

const BROWSER_FINGERPRINTS = [
  {
    // Chrome 132 / Windows
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="132", "Google Chrome";v="132", "Not-A.Brand";v="99"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"'
  },
  {
    // Edge 132 / Windows
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0",
    secChUa: '"Chromium";v="132", "Microsoft Edge";v="132", "Not-A.Brand";v="99"',
    secChUaMobile: "?0",
    secChUaPlatform: '"Windows"'
  },
  {
    // Chrome 132 / macOS
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    secChUa: '"Chromium";v="132", "Google Chrome";v="132", "Not-A.Brand";v="99"',
    secChUaMobile: "?0",
    secChUaPlatform: '"macOS"'
  },
  {
    // Firefox 135 / Windows — does not send Client Hints
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
    secChUa: null,
    secChUaMobile: null,
    secChUaPlatform: null
  },
  {
    // Safari 17 / macOS — does not send Client Hints
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    secChUa: null,
    secChUaMobile: null,
    secChUaPlatform: null
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
  // Client Hints (sec-ch-ua-*) are only included for Chromium-based profiles;
  // Firefox and Safari do not emit them so we omit them for those profiles.
  getStealthHeaders() {
    const fp = BROWSER_FINGERPRINTS[Math.floor(Math.random() * BROWSER_FINGERPRINTS.length)];
    const headers = {
      "User-Agent": fp.userAgent,
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "upgrade-insecure-requests": "1"
    };
    if (fp.secChUa) {
      headers["sec-ch-ua"] = fp.secChUa;
      headers["sec-ch-ua-mobile"] = fp.secChUaMobile;
      headers["sec-ch-ua-platform"] = fp.secChUaPlatform;
    }
    return headers;
  },

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};

this.Utils = Utils;

