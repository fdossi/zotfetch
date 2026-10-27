// chrome/content/prefs.mjs
// Preferences manager

const PREF_PREFIX = 'extensions.zotfetch.';
// Used when the user has not configured a personal e-mail.
// Keeps the real address out of plain-text query parameters (?email=&mailto=).
const FALLBACK_EMAIL = 'zotfetch@gmail.com';

// ─── Secure Credential Storage ───────────────────────────────────────────────
// Sensitive settings (proxy URLs, API keys, email address) are stored via the
// Firefox / Zotero built-in Login Manager (nsILoginManager).  Entries are
// encrypted using the OS credential store or Zotero's master-password key,
// never written as plain text to the SQLite pref database.
//
// One-time migration: on the first startup after upgrading from an older
// ZotFetch version, any plain-text pref value that exists is transparently
// moved to SecureStorage and wiped from the pref store.
const SecureStorage = (() => {
  const HOST  = "zotfetch://credentials";
  const REALM = "ZotFetch";
  const Cc = Components.classes;
  const Ci = Components.interfaces;

  function _mgr() {
    return Services.logins; // nsILoginManager, available in all chrome contexts
  }

  function _makeInfo(username, password) {
    // formActionOrigin must be null for non-form (httpRealm) logins.
    const li = Cc["@mozilla.org/login-manager/loginInfo;1"]
      .createInstance(Ci.nsILoginInfo);
    li.init(HOST, null, REALM, username, String(password ?? ""), "", "");
    return li;
  }

  return {
    /**
     * Retrieve the stored credential for `key`.
     * Returns "" when not found. Callers can request an exception on error.
     */
    get(key, throwOnError = false) {
      try {
        const logins = _mgr().findLogins(HOST, null, REALM);
        return logins.find(l => l.username === key)?.password ?? "";
      } catch (e) {
        Zotero.debug(`[ZotFetch][SecureStorage] get(${key}) error: ${e.message}`);
        if (throwOnError) throw e;
        return "";
      }
    },

    /**
     * Store `value` for `key`.
     * Passing "", null, or undefined removes the entry.
     */
    set(key, value) {
      try {
        const mgr = _mgr();
        const existing = mgr.findLogins(HOST, null, REALM)
          .filter(l => l.username === key);
        if (value === null || value === undefined || value === "") {
          existing.forEach(l => mgr.removeLogin(l));
        } else if (existing.length) {
          mgr.modifyLogin(existing[0], _makeInfo(key, String(value)));
          existing.slice(1).forEach(l => mgr.removeLogin(l));
        } else {
          mgr.addLogin(_makeInfo(key, String(value)));
        }
        return true;
      } catch (e) {
        Zotero.logError(e);
        return false;
      }
    },

    /**
     * One-time migration from a plain-text Zotero pref to SecureStorage.
     * Reads `prefKey`, writes it under `storageKey`, then wipes the pref.
     * Safe to call on every startup — returns early when already migrated.
     */
    migrateFromPref(prefKey, storageKey) {
      try {
        const val = Zotero.Prefs.get(PREF_PREFIX + prefKey, true);
        if (!val) return;                        // nothing to migrate
        if (this.get(storageKey)) return;        // already stored securely
        if (!this.set(storageKey, val) || this.get(storageKey) !== String(val)) return;
        Zotero.Prefs.set(PREF_PREFIX + prefKey, "", true); // wipe plain text
        Zotero.debug(`[ZotFetch][SecureStorage] Migrated '${prefKey}' from plain prefs`);
      } catch (e) {
        Zotero.logError(e);
      }
    }
  };
})();

class ZotFetchPrefs {
  static getUnpaywallEmail() {
    const email = SecureStorage.get("unpaywallEmail");
    return ZotFetchPrefs.isValidEmail(email) ? email : FALLBACK_EMAIL;
  }

  static isCapesEnabled() {
    return Zotero.Prefs.get(`${PREF_PREFIX}enableCapesFallback`, true);
  }

  static isAntiCaptchaMode() {
    return Zotero.Prefs.get(`${PREF_PREFIX}antiCaptchaMode`, true);
  }

  static getRequestDelayMs() {
    const ms = parseInt(Zotero.Prefs.get(`${PREF_PREFIX}requestDelayMs`, true), 10);
    return Number.isFinite(ms) && ms >= 0 ? ms : 1400;
  }

  static isFastModeEnabled() {
    return Zotero.Prefs.get(`${PREF_PREFIX}fastMode`, true);
  }

  static getUnpaywallTimeoutMs() {
    const ms = parseInt(Zotero.Prefs.get(`${PREF_PREFIX}unpaywallTimeoutMs`, true), 10);
    return Number.isFinite(ms) && ms >= 5000 ? ms : 12000;
  }

  static getCrossrefTimeoutMs() {
    const ms = parseInt(Zotero.Prefs.get(`${PREF_PREFIX}crossrefTimeoutMs`, true), 10);
    return Number.isFinite(ms) && ms >= 5000 ? ms : 10000;
  }

  static getBatchSize() {
    const size = parseInt(Zotero.Prefs.get(`${PREF_PREFIX}batchSize`, true), 10);
    return Number.isFinite(size) && size > 0 ? size : 30;
  }

  static getDomainGapMs() {
    const ms = parseInt(Zotero.Prefs.get(`${PREF_PREFIX}domainGapMs`, true), 10);
    return Number.isFinite(ms) && ms >= 0 ? ms : 3000;
  }

  static getRequestTimeoutMs() {
    const ms = parseInt(Zotero.Prefs.get(`${PREF_PREFIX}requestTimeoutMs`, true), 10);
    return Number.isFinite(ms) && ms >= 5000 ? ms : 15000;
  }

  static getProxyUrl() {
    return SecureStorage.get("proxyUrl");
  }

  static getInstitutionalProxyUrl() {
    return SecureStorage.get("institutionalProxyUrl");
  }

  static isInstitutionalProxyEnabled() {
    const url = ZotFetchPrefs.getInstitutionalProxyUrl();
    return !!url && url.trim().length > 0;
  }

  // Free API key from https://core.ac.uk/services/api (optional, but raises
  // rate limit from ~10 req/min to 10k/day).
  static getCoreApiKey() {
    return SecureStorage.get("coreApiKey");
  }
  
  // Secure key exposure
  static getSecure(key) {
    return SecureStorage.get(key, true);
  }

  static setSecure(key, value) {
    return SecureStorage.set(key, value);
  }

  static setSecureBatch(values) {
    const previous = new Map();
    const changed = [];
    try {
      for (const [key, value] of Object.entries(values)) {
        previous.set(key, SecureStorage.get(key, true));
        changed.push(key);
        if (!SecureStorage.set(key, value)) throw new Error("Secure storage write failed");
      }
      return true;
    } catch (error) {
      Zotero.logError(error);
      for (const key of changed.reverse()) {
        if (!SecureStorage.set(key, previous.get(key))) {
          Zotero.logError(new Error(`Secure storage rollback failed for ${key}`));
        }
      }
      return false;
    }
  }

  static set(key, value) {
    Zotero.Prefs.set(PREF_PREFIX + key, value, true);
  }

  /** Open the registered ZotFetch pane in Zotero's preferences window. */
  static openPrefsDialog() {
    try {
      Zotero.Utilities.Internal.openPreferences("zotfetch-preferences");
    } catch (error) {
      Zotero.logError(error);
    }
  }

  // Backward-compatible alias — kept so any external callers still work.
  static openPrefs() {
    return ZotFetchPrefs.openPrefsDialog();
  }
  
  static isValidEmail(email) {
    return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
  }

  /**
   * Run once at startup: migrate any legacy plain-text pref values into
   * SecureStorage and wipe them from the pref database.
   * Each call is idempotent — safe to invoke on every startup.
   */
  static _migrateSecrets() {
    SecureStorage.migrateFromPref("unpaywallEmail",        "unpaywallEmail");
    SecureStorage.migrateFromPref("coreApiKey",            "coreApiKey");
    SecureStorage.migrateFromPref("institutionalProxyUrl", "institutionalProxyUrl");
    SecureStorage.migrateFromPref("proxyUrl",              "proxyUrl");
  }
}

this.ZotFetchPrefs = ZotFetchPrefs;

// Migrate any credentials still stored as plain-text prefs → SecureStorage.
// Runs once per startup; each field is a no-op after the first run.
ZotFetchPrefs._migrateSecrets();

