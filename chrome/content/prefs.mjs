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
     * Returns "" when not found or on error.
     */
    get(key) {
      try {
        const logins = _mgr().findLogins(HOST, null, REALM);
        return logins.find(l => l.username === key)?.password ?? "";
      } catch (e) {
        Zotero.debug(`[ZotFetch][SecureStorage] get(${key}) error: ${e.message}`);
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
        // Remove all existing entries for this key first (guards against
        // duplicate entries that could accumulate from unexpected failures).
        mgr.findLogins(HOST, null, REALM)
          .filter(l => l.username === key)
          .forEach(l => mgr.removeLogin(l));
        if (value !== null && value !== undefined && value !== "")
          mgr.addLogin(_makeInfo(key, String(value)));
      } catch (e) {
        Zotero.logError(e);
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
        this.set(storageKey, val);
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
    return SecureStorage.get("proxyUrl");
  }

  static getInstitutionalProxyUrl() {
    return SecureStorage.get("institutionalProxyUrl");
  }

  static isInstitutionalProxyEnabled() {
    const url = this.getInstitutionalProxyUrl();
    return !!url && url.trim().length > 0;
  }

  // Free API key from https://core.ac.uk/services/api (optional, but raises
  // rate limit from ~10 req/min to 10k/day).
  static getCoreApiKey() {
    return SecureStorage.get("coreApiKey");
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
        get:       (key)        => Zotero.Prefs.get(PREF_PREFIX + key, true),
        set:       (key, value) => Zotero.Prefs.set(PREF_PREFIX + key, value, true),
        // Sensitive fields are read/written via SecureStorage (Login Manager).
        secureGet: (key)        => SecureStorage.get(key),
        secureSet: (key, value) => SecureStorage.set(key, value)
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

