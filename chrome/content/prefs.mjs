// chrome/content/prefs.mjs
// Preferences manager

const PREF_PREFIX = 'extensions.zotfetch.';
// Used when the user has not configured a personal e-mail.
// Keeps the real address out of plain-text query parameters (?email=&mailto=).
const FALLBACK_EMAIL = 'zotfetch@gmail.com';

class ZotFetchPrefs {
  static getUnpaywallEmail() {
    const email = Zotero.Prefs.get(PREF_PREFIX + 'unpaywallEmail', true) || '';
    return this.isValidEmail(email) ? email : FALLBACK_EMAIL;
  }

  static isCapesEnabled() {
    return Zotero.Prefs.get(PREF_PREFIX + 'enableCapesFallback', true);
  }

  static isScihubEnabled() {
    return Zotero.Prefs.get(PREF_PREFIX + 'enableScihubFallback', true);
  }

  static isAntiCaptchaMode() {
    return Zotero.Prefs.get(PREF_PREFIX + 'antiCaptchaMode', true);
  }

  static getRequestDelayMs() {
    const ms = parseInt(Zotero.Prefs.get(PREF_PREFIX + 'requestDelayMs', true), 10);
    return Number.isFinite(ms) && ms >= 0 ? ms : 1400;
  }

  static isFastModeEnabled() {
    return Zotero.Prefs.get(PREF_PREFIX + 'fastMode', true);
  }

  static getFastMirrorLimit() {
    const n = parseInt(Zotero.Prefs.get(PREF_PREFIX + 'fastMirrorLimit', true), 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
  }

  static getUnpaywallTimeoutMs() {
    const ms = parseInt(Zotero.Prefs.get(PREF_PREFIX + 'unpaywallTimeoutMs', true), 10);
    return Number.isFinite(ms) && ms >= 5000 ? ms : 12000;
  }

  static getCrossrefTimeoutMs() {
    const ms = parseInt(Zotero.Prefs.get(PREF_PREFIX + 'crossrefTimeoutMs', true), 10);
    return Number.isFinite(ms) && ms >= 5000 ? ms : 10000;
  }

  static getBatchSize() {
    const size = parseInt(Zotero.Prefs.get(PREF_PREFIX + 'batchSize', true), 10);
    return Number.isFinite(size) && size > 0 ? size : 30;
  }

  static getDomainGapMs() {
    const ms = parseInt(Zotero.Prefs.get(PREF_PREFIX + 'domainGapMs', true), 10);
    return Number.isFinite(ms) && ms >= 0 ? ms : 3000;
  }

  static getRequestTimeoutMs() {
    const ms = parseInt(Zotero.Prefs.get(PREF_PREFIX + 'requestTimeoutMs', true), 10);
    return Number.isFinite(ms) && ms >= 5000 ? ms : 15000;
  }

  static getProxyUrl() {
    return Zotero.Prefs.get(PREF_PREFIX + 'proxyUrl', true) || '';
  }

  static getInstitutionalProxyUrl() {
    return Zotero.Prefs.get(PREF_PREFIX + 'institutionalProxyUrl', true) || '';
  }

  static isInstitutionalProxyEnabled() {
    const url = this.getInstitutionalProxyUrl();
    return !!url && url.trim().length > 0;
  }

  static set(key, value) {
    Zotero.Prefs.set(PREF_PREFIX + key, value, true);
  }

  static openPrefs() {
    // Show current preference values
    const prefs = {
      'Email (Unpaywall)': this.getUnpaywallEmail() || '[Not set]',
      'Institutional Proxy URL': this.getInstitutionalProxyUrl() || '[Not set] - e.g., https://proxy.your-institution.edu/login?url=',
      'Fast Mode': this.isFastModeEnabled() ? 'Enabled' : 'Disabled',
      'Fast Sci-Hub Mirror Limit': this.getFastMirrorLimit(),
      'Unpaywall Timeout (ms)': this.getUnpaywallTimeoutMs(),
      'CrossRef Timeout (ms)': this.getCrossrefTimeoutMs(),
      'Batch Size': this.getBatchSize(),
      'Request Delay (ms)': this.getRequestDelayMs(),
      'Domain Gap (ms)': this.getDomainGapMs(),
      'Anti-Captcha Mode': this.isAntiCaptchaMode() ? 'Enabled' : 'Disabled',
      'CAPES Fallback': this.isCapesEnabled() ? 'Enabled' : 'Disabled',
      'Sci-Hub Fallback': this.isScihubEnabled() ? 'Enabled' : 'Disabled',
      'CAPES Proxy URL': this.getProxyUrl() || '[Not set]'
    };

    let msg = 'ZotFetch Preferences:\n\n';
    for (const [key, value] of Object.entries(prefs)) {
      msg += `${key}: ${value}\n`;
    }
    msg += '\n📍 To edit: Tools → Add-ons → ZotFetch → Preferences (Gear icon)\n';
    msg += 'Or edit directly in about:config filtering "extensions.ZotFetch-batch"\n';
    msg += '\n💡 Institutional Proxy: Your institution proxy URL (e.g., proxy.edu/login?url=)\n';
    msg += 'Used for legal access to paywalled content via your institutional IP.';

    const win = Zotero.getMainWindow?.() || Zotero.getMainWindows?.()[0];
    if (win && win.Zotero?.alert) {
      win.Zotero.alert(null, 'ZotFetch Preferences', msg);
    } else {
      Zotero.alert(null, 'ZotFetch Preferences', msg);
    }
  }

  static isValidEmail(email) {
    return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
  }
}

this.ZotFetchPrefs = ZotFetchPrefs;

