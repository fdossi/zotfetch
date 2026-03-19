// chrome/content/utils.mjs
// Shared utilities: DOI, similarity, validation

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
           text.includes('cloudflare');
  },

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};

this.Utils = Utils;

