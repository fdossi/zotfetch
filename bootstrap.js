/* ZotFetch Bootstrap - Zotero 8 */

// Global namespace
var ZotFetchPlugin = {
  PLUGIN_ID: "zotfetch@edslab.research",
  initialized: false,
  rootURI: null,
  
  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.PLUGIN_ID = id;
    this.rootURI = rootURI;
    this.initialized = true;
    Zotero.debug(`ZotFetch ${version} initialized from ${rootURI}`);
  },

  async startup({ id, version, rootURI }, reason) {
    try {
      this.init({ id, version, rootURI });

      Services.scriptloader.loadSubScript(rootURI + "chrome/content/utils.mjs");
      Services.scriptloader.loadSubScript(rootURI + "chrome/content/prefs.mjs");
      Services.scriptloader.loadSubScript(rootURI + "chrome/content/cooldown.mjs");
      Services.scriptloader.loadSubScript(rootURI + "chrome/content/fetch.mjs");
      Services.scriptloader.loadSubScript(rootURI + "chrome/content/ui.mjs");

      if (typeof ZotFetchUI === "undefined") {
        throw new Error("ZotFetchUI not loaded");
      }

      await ZotFetchUI.init();
      ZotFetchUI.addToAllWindows();

      Zotero.debug("ZotFetch startup complete");
    } catch (error) {
      Zotero.logError(error);
    }
  },

  shutdown({ id, version, rootURI }, reason) {
    try {
      Zotero.getMainWindows().forEach(win => ZotFetchUI.removeFromWindow(win));
      if (ZotFetchUI.menuID && Zotero.MenuManager?.unregisterMenu) {
        Zotero.MenuManager.unregisterMenu(ZotFetchUI.menuID);
      }
      Zotero.debug("ZotFetch shutdown complete");
    } catch (error) {
      Zotero.logError(error);
    }
  },

  install({ id, version, rootURI }, reason) {
    Zotero.debug("ZotFetch installed");
  },

  uninstall({ id, version, rootURI }, reason) {
    Zotero.debug("ZotFetch uninstalled");
  },

  onMainWindowLoad({ window }) {
    if (window.ZoteroPane) {
      ZotFetchUI.addToWindow(window);
    }
  },

  onMainWindowUnload({ window }) {
    ZotFetchUI.removeFromWindow(window);
  }
};

// Export for Zotero bootstrap
this.startup = ZotFetchPlugin.startup.bind(ZotFetchPlugin);
this.shutdown = ZotFetchPlugin.shutdown.bind(ZotFetchPlugin);
this.install = ZotFetchPlugin.install.bind(ZotFetchPlugin);
this.uninstall = ZotFetchPlugin.uninstall.bind(ZotFetchPlugin);
this.onMainWindowLoad = ZotFetchPlugin.onMainWindowLoad.bind(ZotFetchPlugin);
this.onMainWindowUnload = ZotFetchPlugin.onMainWindowUnload.bind(ZotFetchPlugin);

