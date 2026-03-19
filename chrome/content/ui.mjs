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
              menuType: "menuitem",
              label: "ZotFetch Batch Download",
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
              label: "ZotFetch Ultra Fast",
              tooltipText: "Ultra Fast: máxima velocidade (nativo + Unpaywall + proxy institucional). Pode baixar menos PDFs que o modo completo.",
              onCommand: () => {
                if (typeof ZotFetch !== 'undefined') {
                  ZotFetch.runUltraFastBatch();
                } else {
                  Zotero.debug("ZotFetch not loaded");
                }
              }
            },
            {
              menuType: "menuitem",
              label: "ZotFetch Preferences",
              onCommand: () => {
                if (typeof ZotFetchPrefs !== 'undefined') {
                  ZotFetchPrefs.openPrefs();
                }
              }
            },
            {
              menuType: "menuitem",
              label: "ZotFetch Retry Failed",
              tooltipText: "Tenta novamente apenas os itens que falharam no último batch.",
              onCommand: () => {
                if (typeof ZotFetch !== 'undefined') {
                  ZotFetch.runRetryFailed();
                }
              }
            },
            {
              menuType: "menuitem",
              label: "ZotFetch Retry After Auth",
              tooltipText: "Abre DOIs no navegador para autenticação, depois retenta itens com captcha/bloqueio.",
              onCommand: () => {
                if (typeof ZotFetch !== 'undefined') {
                  ZotFetch.runRetryAfterAuth();
                }
              }
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
    if (doc.getElementById('zotfetch-menu')) return;

    const popup = doc.getElementById("zotero-itemmenu");
    if (!popup) return;

    // Batch download item with PDF icon
    const item = doc.createXULElement("menuitem");
    item.id = "zotfetch-menu";
    item.className = "menuitem-iconic";
    item.setAttribute("image", "chrome://zotero/skin/treeitem-attachment-pdf-small.png");
    item.setAttribute("label", "ZotFetch Batch Download");
    item.addEventListener("command", () => {
      if (typeof ZotFetch !== 'undefined') {
        ZotFetch.runBatch().catch((error) => {
          Zotero.logError(error);
          Zotero.alert(null, "ZotFetch", "Erro ao executar ZotFetch Batch Download.");
        });
      }
    });
    popup.appendChild(item);

    // Ultra fast download item
    const ultraItem = doc.createXULElement("menuitem");
    ultraItem.id = "zotfetch-ultra";
    ultraItem.className = "menuitem-iconic";
    ultraItem.setAttribute("image", "chrome://zotero/skin/sync.png");
    ultraItem.setAttribute("label", "ZotFetch Ultra Fast");
    ultraItem.setAttribute("tooltiptext", "Ultra Fast: máxima velocidade (nativo + Unpaywall + proxy institucional). Pode baixar menos PDFs que o modo completo.");
    ultraItem.addEventListener("command", () => {
      if (typeof ZotFetch !== 'undefined') {
        ZotFetch.runUltraFastBatch().catch((error) => {
          Zotero.logError(error);
          Zotero.alert(null, "ZotFetch", "Erro ao executar ZotFetch Ultra Fast.");
        });
      }
    });
    popup.appendChild(ultraItem);

    // Config item
    const configItem = doc.createXULElement("menuitem");
    configItem.id = "zotfetch-config";
    configItem.className = "menuitem-iconic";
    configItem.setAttribute("image", "chrome://zotero/skin/preferences.png");
    configItem.setAttribute("label", "ZotFetch Preferences");
    configItem.addEventListener("command", () => {
      if (typeof ZotFetchPrefs !== 'undefined') {
        ZotFetchPrefs.openPrefs();
      }
    });
    popup.appendChild(configItem);

    // Retry failed items
    const retryItem = doc.createXULElement("menuitem");
    retryItem.id = "zotfetch-retry";
    retryItem.className = "menuitem-iconic";
    retryItem.setAttribute("image", "chrome://zotero/skin/treeitem-attachment-pdf-small.png");
    retryItem.setAttribute("label", "ZotFetch Retry Failed");
    retryItem.setAttribute("tooltiptext", "Tenta novamente apenas os itens que falharam no último batch.");
    retryItem.addEventListener("command", () => {
      if (typeof ZotFetch !== 'undefined') {
        ZotFetch.runRetryFailed().catch(e => Zotero.logError(e));
      }
    });
    popup.appendChild(retryItem);

    // Retry after auth
    const retryAuthItem = doc.createXULElement("menuitem");
    retryAuthItem.id = "zotfetch-retry-auth";
    retryAuthItem.className = "menuitem-iconic";
    retryAuthItem.setAttribute("image", "chrome://zotero/skin/sync.png");
    retryAuthItem.setAttribute("label", "ZotFetch Retry After Auth");
    retryAuthItem.setAttribute("tooltiptext", "Abre DOIs no navegador para autenticação, depois retenta itens com captcha/bloqueio.");
    retryAuthItem.addEventListener("command", () => {
      if (typeof ZotFetch !== 'undefined') {
        ZotFetch.runRetryAfterAuth().catch(e => Zotero.logError(e));
      }
    });
    popup.appendChild(retryAuthItem);

    Zotero.debug("ZotFetch DOM menu added to window");
  }

  static removeFromWindow(window) {
    const doc = window.document;
    doc.getElementById('zotfetch-menu')?.remove();
    doc.getElementById('zotfetch-ultra')?.remove();
    doc.getElementById('zotfetch-config')?.remove();
    doc.getElementById('zotfetch-retry')?.remove();
    doc.getElementById('zotfetch-retry-auth')?.remove();
  }
}

this.ZotFetchUI = ZotFetchUI;

