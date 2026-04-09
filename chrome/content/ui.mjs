// chrome/content/ui.mjs
// UI Module: Menus, progress, window management

class ZotFetchUI {
  static PLUGIN_ID = "zotfetch@edslab.research";
  static menuID = null;

  static async init() {
    if (Zotero.MenuManager?.registerMenu) {
      try {
        this.menuID = Zotero.MenuManager.registerMenu({
          menuID: "zotfetch-main-menu",
          pluginID: this.PLUGIN_ID,
          target: "main/library/item",
          menus: [
            {
              menuType: "menu",
              label: "ZotFetch",
              menus: [
                {
                  menuType: "menuitem",
                  label: "Batch Download",
                  onCommand: () => {
                    if (typeof ZotFetch !== 'undefined') {
                      ZotFetch.runBatch();
                    } else {
                      Zotero.debug("ZotFetch not loaded");
                    }
                  }
                },
                {
                  menuType: "menuitem",
                  label: "Ultra Fast",
                  tooltipText: "Ultra Fast: single-pass, OA + one Sci-Hub mirror. May download fewer PDFs.",
                  onCommand: () => {
                    if (typeof ZotFetch !== 'undefined') {
                      ZotFetch.runUltraFastBatch();
                    } else {
                      Zotero.debug("ZotFetch not loaded");
                    }
                  }
                },
                {
                  menuType: "menuseparator"
                },
                {
                  menuType: "menuitem",
                  label: "Retry Failed",
                  tooltipText: "Re-attempts only the items that failed in the last batch.",
                  onCommand: () => {
                    if (typeof ZotFetch !== 'undefined') {
                      ZotFetch.runRetryFailed();
                    }
                  }
                },
                {
                  menuType: "menuitem",
                  label: "Retry After Auth",
                  tooltipText: "Opens DOIs in browser for authentication, then retries captcha/blocked items.",
                  onCommand: () => {
                    if (typeof ZotFetch !== 'undefined') {
                      ZotFetch.runRetryAfterAuth();
                    }
                  }
                },
                {
                  menuType: "menuseparator"
                },
                {
                  menuType: "menuitem",
                  label: "Preferences",
                  onCommand: () => {
                    if (typeof ZotFetchPrefs !== 'undefined') {
                      ZotFetchPrefs.openPrefsDialog();
                    }
                  }
                }
              ]
            }
          ]
        });
        Zotero.debug(`ZotFetch MenuManager registered: ${this.menuID}`);
      } catch (error) {
        Zotero.logError(error);
      }
    }
  }

  // Fallback/legacy for DOM injection
  static addToAllWindows() {
    Zotero.getMainWindows().forEach(win => {
      if (win.ZoteroPane) this.addToWindow(win);
    });
  }

  static addToWindow(window) {
    const doc = window.document;
    if (doc.getElementById('zotfetch-root')) return;

    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup) return;

    // Top-level "ZotFetch ▶" submenu
    const menu = doc.createXULElement("menu");
    menu.id = "zotfetch-root";
    menu.className = "menu-iconic";
    menu.setAttribute("image", "chrome://zotero/skin/treeitem-attachment-pdf-small.png");
    menu.setAttribute("label", "ZotFetch");

    const subpopup = doc.createXULElement("menupopup");
    menu.appendChild(subpopup);

    // Batch Download
    const batchItem = doc.createXULElement("menuitem");
    batchItem.id = "zotfetch-menu";
    batchItem.setAttribute("label", "Batch Download");
    batchItem.addEventListener("command", () => {
      if (typeof ZotFetch !== 'undefined') {
        ZotFetch.runBatch().catch(e => Zotero.logError(e));
      }
    });
    subpopup.appendChild(batchItem);

    // Ultra Fast
    const ultraItem = doc.createXULElement("menuitem");
    ultraItem.id = "zotfetch-ultra";
    ultraItem.setAttribute("label", "Ultra Fast");
    ultraItem.setAttribute("tooltiptext", "Single-pass, OA + one Sci-Hub mirror. May download fewer PDFs.");
    ultraItem.addEventListener("command", () => {
      if (typeof ZotFetch !== 'undefined') {
        ZotFetch.runUltraFastBatch().catch(e => Zotero.logError(e));
      }
    });
    subpopup.appendChild(ultraItem);

    subpopup.appendChild(doc.createXULElement("menuseparator"));

    // Retry Failed
    const retryItem = doc.createXULElement("menuitem");
    retryItem.id = "zotfetch-retry";
    retryItem.setAttribute("label", "Retry Failed");
    retryItem.setAttribute("tooltiptext", "Re-attempts only the items that failed in the last batch.");
    retryItem.addEventListener("command", () => {
      if (typeof ZotFetch !== 'undefined') {
        ZotFetch.runRetryFailed().catch(e => Zotero.logError(e));
      }
    });
    subpopup.appendChild(retryItem);

    // Retry After Auth
    const retryAuthItem = doc.createXULElement("menuitem");
    retryAuthItem.id = "zotfetch-retry-auth";
    retryAuthItem.setAttribute("label", "Retry After Auth");
    retryAuthItem.setAttribute("tooltiptext", "Opens DOIs in browser for authentication, then retries captcha/blocked items.");
    retryAuthItem.addEventListener("command", () => {
      if (typeof ZotFetch !== 'undefined') {
        ZotFetch.runRetryAfterAuth().catch(e => Zotero.logError(e));
      }
    });
    subpopup.appendChild(retryAuthItem);

    subpopup.appendChild(doc.createXULElement("menuseparator"));

    // Preferences
    const configItem = doc.createXULElement("menuitem");
    configItem.id = "zotfetch-config";
    configItem.setAttribute("label", "Preferences");
    configItem.addEventListener("command", () => {
      if (typeof ZotFetchPrefs !== 'undefined') {
        ZotFetchPrefs.openPrefsDialog();
      }
    });
    subpopup.appendChild(configItem);

    popup.appendChild(menu);
    Zotero.debug("ZotFetch DOM submenu added to window");
  }

  static removeFromWindow(window) {
    const doc = window.document;
    doc.getElementById('zotfetch-root')?.remove();
  }
}

this.ZotFetchUI = ZotFetchUI;

