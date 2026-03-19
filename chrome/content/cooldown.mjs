// chrome/content/cooldown.mjs
// Domain cooldown and rate limiting

class CooldownManager {
  constructor() {
    this.domainCooldowns = new Map();
    this.domainLastRequest = new Map();
    this.domainCaptchaCount = new Map(); // consecutive captcha counter
    this.domainFailureCounts = new Map(); // non-captcha failure counter for adaptive backoff
    this.DOMAIN_COOLDOWN_MS = 30 * 60 * 1000;
    this.DEFAULT_DOMAIN_GAP_MS = 3000;
    this.CAPTCHA_THRESHOLD = 3; // block domain after 3 consecutive captchas
  }

  isDomainCoolingDown(domain) {
    const until = this.domainCooldowns.get(domain);
    if (!until || until <= Date.now()) {
      this.domainCooldowns.delete(domain);
      return false;
    }
    return true;
  }

  markDomainCaptcha(domain) {
    const count = (this.domainCaptchaCount.get(domain) || 0) + 1;
    this.domainCaptchaCount.set(domain, count);
    Zotero.debug(`[ZotFetch] Captcha hit #${count} on ${domain}`);

    if (count >= this.CAPTCHA_THRESHOLD) {
      this.domainCooldowns.set(domain, Date.now() + this.DOMAIN_COOLDOWN_MS);
      Zotero.debug(`[ZotFetch] Domain blocked ${this.DOMAIN_COOLDOWN_MS / 60000}min after ${count} captchas: ${domain}`);
    }
  }

  markDomainSuccess(domain) {
    // Reset consecutive captcha counter on successful request
    if (this.domainCaptchaCount.has(domain)) {
      this.domainCaptchaCount.delete(domain);
      Zotero.debug(`[ZotFetch] Captcha counter reset (success): ${domain}`);
    }
    // Reset failure counter so adaptive backoff clears on success
    this.domainFailureCounts.delete(domain);
  }

  markDomainNonCaptcha(domain) {
    // Any non-captcha response should reset consecutive captcha streak
    if (this.domainCaptchaCount.has(domain)) {
      this.domainCaptchaCount.delete(domain);
      Zotero.debug(`[ZotFetch] Captcha counter reset (non-captcha): ${domain}`);
    }
    // Increment non-captcha failure count for adaptive backoff
    const n = (this.domainFailureCounts.get(domain) || 0) + 1;
    this.domainFailureCounts.set(domain, n);
    if (n > 1) {
      Zotero.debug(`[ZotFetch] Non-captcha failure #${n} for ${domain}, adaptive gap active`);
    }
  }

  async honorDomainGap(domain, prefs) {
    const baseGap = parseInt(prefs.getDomainGapMs()) || this.DEFAULT_DOMAIN_GAP_MS;
    const failureCount = this.domainFailureCounts.get(domain) || 0;
    // Adaptive extra wait: 0, +1s, +2s, +4s, ... capped at +15s
    const adaptiveExtra = failureCount > 0
      ? Math.min(1000 * Math.pow(2, failureCount - 1), 15000)
      : 0;
    const gap = baseGap + adaptiveExtra;
    if (gap <= 0) return;

    const last = this.domainLastRequest.get(domain) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < gap) {
      const wait = gap - elapsed;
      Zotero.debug(`[ZotFetch] Gap wait ${wait}ms${adaptiveExtra > 0 ? ` (adaptive +${adaptiveExtra}ms, failure #${failureCount})` : ''}: ${domain}`);
      await new Promise(r => setTimeout(r, wait));
    }
    this.domainLastRequest.set(domain, Date.now());
  }

  async sleepWithJitter(baseMs) {
    const jitter = Math.floor(baseMs * 0.3 * (Math.random() * 2 - 1));
    await new Promise(r => setTimeout(r, Math.max(500, baseMs + jitter)));
  }
}

this.CooldownManager = CooldownManager;

