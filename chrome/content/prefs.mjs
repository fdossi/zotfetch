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

  // Free API key from https://core.ac.uk/services/api (optional, but raises
  // rate limit from ~10 req/min to 10k/day).
  static getCoreApiKey() {
    return Zotero.Prefs.get(PREF_PREFIX + 'coreApiKey', true) || '';
  }

  static set(key, value) {
    Zotero.Prefs.set(PREF_PREFIX + key, value, true);
  }

  /**
   * Open the graphical ZotFetch preferences dialog.
   * Reads and writes directly to/from Zotero.Prefs via a bridge object
   * passed to the XHTML dialog through window.arguments[0].
   */
  static openPrefsDialog() {
    try {
      const win = Zotero.getMainWindow?.() ?? Zotero.getMainWindows?.()?.[0];
      if (!win) {
        Zotero.logError(new Error("[ZotFetch] openPrefsDialog: no main window available"));
        return;
      }

      // Bridge object: isolates the dialog from direct Zotero.Prefs access and
      // lets us pass functions across the chrome window boundary safely.
      const prefsBridge = {
        version: ZotFetchPlugin?.version || "",
        get: (key) => Zotero.Prefs.get(PREF_PREFIX + key, true),
        set: (key, value) => Zotero.Prefs.set(PREF_PREFIX + key, value, true)
      };

      const dialogUrl = ZotFetchPlugin.rootURI + "chrome/content/prefs-dialog.xhtml";
      win.openDialog(
        dialogUrl,
        "zotfetch-preferences",
        "chrome,titlebar,centerscreen,resizable=yes,modal",
        prefsBridge
      );
    } catch (error) {
      Zotero.logError(error);
    }
  }

  // Backward-compatible alias — kept so any external callers still work.
  static openPrefs() {
    return this.openPrefsDialog();
  }

  static isValidEmail(email) {
    return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
  }
}

this.ZotFetchPrefs = ZotFetchPrefs;

