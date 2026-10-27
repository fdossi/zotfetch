import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (name) => readFileSync(join(root, name), "utf8");
let passed = 0;

async function test(name, run) {
  await run();
  passed++;
  process.stdout.write(`ok - ${name}\n`);
}

await test("credential migration retains old preference when Login Manager fails", () => {
  const prefs = new Map([["extensions.zotfetch.coreApiKey", "fixture-key"]]);
  const logins = [];
  let fail = true;
  let failOnKey = "";
  const context = vm.createContext({
    Zotero: {
      Prefs: {
        get: (key) => prefs.get(key),
        set: (key, value) => prefs.set(key, value)
      },
      debug() {}, logError() {}
    },
    Services: {
      logins: {
        findLogins: () => logins,
        addLogin(login) {
          if (fail || login.username === failOnKey) throw new Error("locked");
          logins.push(login);
        },
        removeLogin(login) { logins.splice(logins.indexOf(login), 1); },
        modifyLogin(oldLogin, newLogin) { logins.splice(logins.indexOf(oldLogin), 1, newLogin); }
      }
    },
    Components: {
      classes: {
        "@mozilla.org/login-manager/loginInfo;1": {
          createInstance: () => ({
            init(_host, _form, _realm, username, password) {
              this.username = username;
              this.password = password;
            }
          })
        }
      },
      interfaces: { nsILoginInfo: {} }
    }
  });
  vm.runInContext(source("chrome/content/prefs.mjs"), context);
  assert.equal(prefs.get("extensions.zotfetch.coreApiKey"), "fixture-key");
  fail = false;
  vm.runInContext("ZotFetchPrefs._migrateSecrets()", context);
  assert.equal(logins[0].password, "fixture-key");
  assert.equal(prefs.get("extensions.zotfetch.coreApiKey"), "");
  failOnKey = "proxyUrl";
  const saved = vm.runInContext("ZotFetchPrefs.setSecureBatch({ unpaywallEmail: 'fixture-email', proxyUrl: 'fixture-proxy' })", context);
  assert.equal(saved, false);
  assert.equal(logins.some(login => login.username === "unpaywallEmail"), false);
});

await test("resolver chain retains strongest failure reason", async () => {
  const context = vm.createContext({
    CooldownManager: class {},
    ProtectedHosts: {
      ProtectedHostNegativeCache: class {},
      ItemHostAttemptTracker: class {}
    },
    ZotFetchPrefs: { getRequestTimeoutMs: () => 5000 },
    Utils: { getStealthHeaders: () => ({ "User-Agent": "test" }), isSafeDestinationURL: () => true },
    Zotero: { debug() {}, logError() {} }
  });
  vm.runInContext(source("chrome/content/fetch.mjs"), context);
  const candidate = { url: "https://example.org/article" };
  const resolvers = ["auth", "nopdf"].map(failureReason => ({
    canResolve: () => true,
    resolve: async () => ({ ok: false, failureReason })
  }));
  const result = await context.ZotFetch._resolveCandidate(candidate, resolvers);
  assert.equal(result.failureReason, "auth");
});

await test("PDF availability distinguishes missing files from queued sync", async () => {
  let attachments = [];
  const context = vm.createContext({
    CooldownManager: class {},
    ProtectedHosts: {
      ProtectedHostNegativeCache: class {},
      ItemHostAttemptTracker: class {}
    },
    Zotero: {
      debug() {}, logError() {},
      Items: { getAsync: async () => attachments },
      Sync: { Storage: { Local: { SYNC_STATE_TO_DOWNLOAD: 3, SYNC_STATE_FORCE_DOWNLOAD: 4 } } }
    }
  });
  vm.runInContext(source("chrome/content/fetch.mjs"), context);
  const item = { getAttachments: () => [1] };
  attachments = [{ isPDFAttachment: () => true, fileExists: async () => false, attachmentSyncState: 0 }];
  assert.equal(await context.ZotFetch.hasPDF(item), false);
  attachments[0].attachmentSyncState = 3;
  assert.equal(await context.ZotFetch.hasPDF(item), true);
  attachments[0].attachmentSyncState = 0;
  attachments[0].fileExists = async () => true;
  assert.equal(await context.ZotFetch.hasPDF(item), true);
});

await test("zero gap is respected on ordinary domains; protected minimum remains", async () => {
  let now = 10000;
  const waits = [];
  const context = vm.createContext({
    Zotero: { debug() {} },
    Date: { now: () => now },
    setTimeout: (callback, ms) => { waits.push(ms); callback(); },
    ProtectedHosts: { getHostPolicy: (host) => host === "protected.org" ? { minGapMs: 8000 } : null }
  });
  vm.runInContext(source("chrome/content/cooldown.mjs"), context);
  const manager = vm.runInContext("new CooldownManager()", context);
  const prefs = { getDomainGapMs: () => 0 };
  await manager.honorDomainGap("ordinary.org", prefs);
  await manager.honorDomainGap("ordinary.org", prefs);
  assert.deepEqual(waits, []);
  await manager.honorDomainGap("protected.org", prefs);
  await manager.honorDomainGap("protected.org", prefs);
  assert.deepEqual(waits, [8000]);
});

await test("startup awaits pane registration and shutdown releases it", async () => {
  const events = [];
  const context = vm.createContext({
    Zotero: {
      debug() {}, logError: (error) => { throw error; },
      getMainWindows: () => [],
      PreferencePanes: {
        register: async (options) => { events.push(options); return options.id; },
        unregister: (id) => events.push(`unregister:${id}`)
      },
      MenuManager: { unregisterMenu: (id) => events.push(`unmenu:${id}`) }
    },
    Services: { scriptloader: { loadSubScript() {} } },
    ZotFetchPrefs: class {},
    ZotFetchUI: {
      menuID: "menu", init: async () => {}, removeFromWindow() {}, addToAllWindows() {}
    }
  });
  vm.runInContext(source("bootstrap.js"), context);
  const data = { id: "zotfetch@edslab.research", version: "test", rootURI: "jar:test!/" };
  await context.startup(data, 0);
  assert.equal(events[0].id, "zotfetch-preferences");
  assert.equal(events[0].scripts.length, 1);
  assert.equal(context.Zotero.ZotFetchPrefs, context.ZotFetchPrefs);
  context.shutdown(data, 0);
  assert(events.includes("unregister:zotfetch-preferences"));
  assert.equal(context.Zotero.ZotFetchPrefs, undefined);
});

await test("managed menu retains Preferences entry", async () => {
  let menu;
  let opened = false;
  const context = vm.createContext({
    Zotero: {
      debug() {}, logError() {},
      MenuManager: { registerMenu: (definition) => { menu = definition; return definition.menuID; } }
    },
    ZotFetchPrefs: { openPrefsDialog: () => { opened = true; } }
  });
  vm.runInContext(source("chrome/content/ui.mjs"), context);
  await context.ZotFetchUI.init();
  const entry = menu.menus[0].menus.find(item => item.label === "Preferences");
  assert(entry);
  entry.onCommand();
  assert.equal(opened, true);
});

await test("pane refuses to close or save ordinary preferences when secure storage fails", () => {
  const html = source("chrome/content/prefs-dialog.xhtml");
  const dom = new JSDOM(html, { contentType: "application/xml" });
  const document = dom.window.document;
  document.getElementById("zotfetch-errMsg").scrollIntoView = () => {};
  const saved = [];
  let closed = false;
  const context = vm.createContext({
    document,
    window: { addEventListener() {}, close() { closed = true; }, confirm: () => true },
    Zotero: {
      Prefs: { get: () => undefined, set: (...args) => saved.push(args) },
      ZotFetchPrefs: { getSecure: () => "", setSecureBatch: () => false },
      launchURL() {}
    }
  });
  vm.runInContext(source("chrome/content/prefs-dialog.js"), context);
  vm.runInContext("initPrefsPane()", context);
  vm.runInContext("savePrefs()", context);
  assert.equal(closed, false);
  assert.equal(saved.length, 0);
  assert.match(document.getElementById("zotfetch-errMsg").textContent, /Could not save/);
});

await test("native preferences pane loads defaults without saving and can discard edits", () => {
  const dom = new JSDOM(source("chrome/content/prefs-dialog.xhtml"), { contentType: "application/xml" });
  const document = dom.window.document;
  document.getElementById("zotfetch-errMsg").scrollIntoView = () => {};
  const saved = [];
  let closed = false;
  const context = vm.createContext({
    document,
    window: { addEventListener() {}, close() { closed = true; }, confirm: () => true },
    Zotero: {
      Prefs: { get: key => key.endsWith("batchSize") ? 12 : undefined,
        set: (...args) => saved.push(args) },
      ZotFetchPrefs: { getSecure: () => "", setSecureBatch: () => true },
      launchURL() {}
    }
  });
  vm.runInContext(source("chrome/content/prefs-dialog.js"), context);
  vm.runInContext("initPrefsPane()", context);
  assert.equal(document.getElementById("zotfetch-f-batch").value, "12");
  vm.runInContext("resetDefaults()", context);
  assert.equal(document.getElementById("zotfetch-f-batch").value, "30");
  assert.equal(saved.length, 0);
  vm.runInContext("discardChanges()", context);
  assert.equal(document.getElementById("zotfetch-f-batch").value, "12");
  assert.equal(closed, false);
  vm.runInContext("savePrefs()", context);
  assert(saved.length > 0);
  assert.equal(closed, false);
  assert.match(document.getElementById("zotfetch-statusMsg").textContent, /saved/i);
});

await test("network URL guard rejects local addresses and credentials", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(source("chrome/content/utils.mjs"), context);
  const safe = (url, allowPrivate = false) => context.Utils.isSafeNetworkURL(url, allowPrivate);
  for (const url of ["file:///tmp/a.pdf", "http://localhost/x", "http://127.0.0.1/x",
    "http://10.0.0.1/x", "http://192.168.1.1/x", "http://169.254.1.2/x",
    "http://[::1]/x", "http://localhost./x", "http://[::ffff:127.0.0.1]/x",
    "http://100.64.0.1/x", "http://[fd00::1]/x",
    "https://user:pass@example.org/x"]) {
    assert.equal(safe(url), false, url);
  }
  assert.equal(safe("https://example.org/a.pdf"), true);
  assert.equal(safe("https://fda.gov/a.pdf"), true);
  assert.equal(safe("https://[2606:4700::1111]/a.pdf"), true);
  assert.equal(safe("http://10.0.0.1/x", true), true);
});

await test("safe request blocks private redirects and strips credentials across origins", async () => {
  const calls = [];
  const context = vm.createContext({ URL, Zotero: { HTTP: { request: async (_method, url, options) => {
    calls.push({ url, options });
    if (url === "https://public.example/redirect-private") return {
      status: 302, getResponseHeader: () => "http://127.0.0.1/private"
    };
    if (url === "https://public.example/redirect-public") return {
      status: 302, getResponseHeader: () => "https://other.example/pdf"
    };
    return { status: 200, getResponseHeader: () => "application/pdf" };
  } } } });
  vm.runInContext(source("chrome/content/utils.mjs"), context);
  await assert.rejects(context.Utils.safeRequest("GET", "https://public.example/redirect-private"));
  assert.equal(calls.length, 1);
  const response = await context.Utils.safeRequest("GET", "https://public.example/redirect-public", {
    headers: { Authorization: "Bearer fixture", Cookie: "fixture", Accept: "application/pdf" }
  });
  assert.equal(response.zotfetchFinalURL, "https://other.example/pdf");
  assert.equal(calls[1].options.followRedirects, false);
  assert.equal(calls[2].options.headers.Authorization, undefined);
  assert.equal(calls[2].options.headers.Cookie, undefined);
  assert.equal(calls[2].options.headers.Accept, "application/pdf");
});

await test("DNS preflight rejects a private answer before HTTP", async () => {
  let httpCalls = 0;
  const context = vm.createContext({ URL,
    Services: { tm: { mainThread: {} }, dns: { asyncResolve(_host, _type, _flags, _info, listener) {
      const addresses = ["10.1.2.3"];
      listener.onLookupComplete(null, {
        hasMore: () => addresses.length > 0,
        getNextAddrAsString: () => addresses.shift()
      }, 0);
    } } },
    Zotero: { HTTP: { request: async () => { httpCalls++; return { status: 200 }; } } }
  });
  vm.runInContext(source("chrome/content/utils.mjs"), context);
  await assert.rejects(context.Utils.safeRequest("GET", "https://public.example/pdf"));
  assert.equal(httpCalls, 0);
});

await test("proxy exception applies only to its configured host and logs omit URL secrets", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(source("chrome/content/utils.mjs"), context);
  const policy = { privateHost: "proxy.example.edu" };
  assert.equal(context.Utils.isSafeDestinationURL("https://proxy.example.edu/pdf", policy), true);
  assert.equal(context.Utils.isSafeDestinationURL("http://127.0.0.1/pdf", policy), false);
  assert.equal(context.Utils.urlForLog("https://example.org/pdf?token=fixture-secret"), "example.org");
  assert.equal(context.Utils.errorForLog({ name: "https://example.org/?token=fixture-secret" }), "NetworkError");
  assert.equal(context.Utils.isTrustedBrowserHost("https://link.springer.com/article"), true);
  assert.equal(context.Utils.isTrustedBrowserHost("https://evil-springer.com/article"), false);
});

await test("source discovery stops before later providers and preserves priority order", async () => {
  const context = vm.createContext({
    CooldownManager: class {},
    ProtectedHosts: { ProtectedHostNegativeCache: class {}, ItemHostAttemptTracker: class {} },
    Zotero: { debug() {}, logError(error) { throw error; } }
  });
  vm.runInContext(source("chrome/content/fetch.mjs"), context);
  const built = [];
  const resolvers = [
    { id: "native", enabled: () => true, buildCandidates: async () => {
      built.push("native"); return [{ sourceId: "native", priority: 110 }];
    } },
    { id: "unpaywall", enabled: () => true, buildCandidates: async () => {
      built.push("unpaywall"); return [{ sourceId: "unpaywall", priority: 85 }];
    } },
    { id: "semanticscholar", enabled: () => true, buildCandidates: async () => {
      built.push("semanticscholar"); return [{ sourceId: "semanticscholar", priority: 95 }];
    } },
    { id: "core", enabled: () => true, buildCandidates: async () => {
      built.push("core"); return [{ sourceId: "core", priority: 85 }];
    } }
  ];
  const stream = context.ZotFetch._candidateStream({}, {}, resolvers);
  assert.equal((await stream.next()).value.sourceId, "native");
  assert.deepEqual(built, ["native"]);
  const remaining = [];
  for await (const candidate of stream) remaining.push(candidate.sourceId);
  assert.deepEqual(remaining, ["semanticscholar", "unpaywall", "core"]);
});

await test("candidate deduplication respects request headers and access route", () => {
  const context = vm.createContext({
    CooldownManager: class {},
    ProtectedHosts: { ProtectedHostNegativeCache: class {}, ItemHostAttemptTracker: class {} }
  });
  vm.runInContext(source("chrome/content/fetch.mjs"), context);
  const key = candidate => context.ZotFetch._candidateKey(candidate);
  const base = { sourceId: "unpaywall", url: "https://example.org/a.pdf",
    kind: "direct-pdf", headers: { Referer: "https://example.org/" } };
  assert.equal(key(base), key({ ...base, sourceId: "openalex", headers: { referer: "https://example.org/" } }));
  assert.notEqual(key(base), key({ ...base, headers: { Referer: "https://different.org/" } }));
  assert.notEqual(key(base), key({ ...base, sourceId: "capes" }));
  assert.equal(key({ ...base, sourceId: "scihub" }), null);
});

await test("validated PDF blob is imported once through Zotero storage", async () => {
  let attached = false;
  let urlDownloads = 0;
  let writtenBlob;
  const context = vm.createContext({
    OS: { Path: { join: (...parts) => parts.join("/") }, File: {
      remove: async () => {}, removeDir: async () => {}
    } },
    Utils: { isSafeDestinationURL: () => true, urlForLog: () => "example.org",
      errorForLog: () => "NetworkError", getDomain: () => "example.org",
      getStealthHeaders: () => ({}) },
    ZotFetch: { hasPDF: async () => attached, cooldown: {
      markDomainSuccess() {}, markDomainNonCaptcha() {}
    } },
    Zotero: { debug() {}, logError(error) { throw error; },
      File: { putContentsAsync: async (_path, blob) => { writtenBlob = blob; } },
      Attachments: {
        createTemporaryStorageDirectory: async () => ({ path: "temporary" }),
        createURLAttachmentFromTemporaryStorageDirectory: async options => {
          assert.equal(options.contentType, "application/pdf"); attached = true;
        },
        importFromURL: async () => { urlDownloads++; }
      }
    }
  });
  vm.runInContext(source("chrome/content/importer.mjs"), context);
  const blob = new Blob(["%PDF-1.7\nfixture"], { type: "application/pdf" });
  const ok = await context.AttachmentImporter.importResolvedPdf(
    { id: 1, libraryID: 1 }, { ok: true, finalPdfUrl: "https://example.org/a.pdf", pdfBlob: blob }, "Test");
  assert.equal(ok, true);
  assert.equal(writtenBlob, blob);
  assert.equal(urlDownloads, 0);
});

await test("blob storage failure does not start an unchecked URL import", async () => {
  let attached = false;
  let urlDownloads = 0;
  const context = vm.createContext({
    OS: { Path: { join: (...parts) => parts.join("/") }, File: {
      remove: async () => {}, removeDir: async () => {}
    } },
    Utils: { isSafeDestinationURL: () => true, urlForLog: () => "example.org",
      errorForLog: () => "NetworkError", getDomain: () => "example.org",
      getStealthHeaders: () => ({}) },
    ZotFetch: { hasPDF: async () => attached, cooldown: {
      markDomainSuccess() {}, markDomainNonCaptcha() {}
    } },
    Zotero: { debug() {}, logError() {},
      File: { putContentsAsync: async () => { throw new Error("disk unavailable"); } },
      Attachments: {
        createTemporaryStorageDirectory: async () => ({ path: "temporary" }),
        createURLAttachmentFromTemporaryStorageDirectory: async () => {},
        importFromURL: async () => { urlDownloads++; attached = true; }
      }
    }
  });
  vm.runInContext(source("chrome/content/importer.mjs"), context);
  const ok = await context.AttachmentImporter.importResolvedPdf(
    { id: 1, libraryID: 1 }, { ok: true, finalPdfUrl: "https://example.org/a.pdf", pdfBlob: new Blob(["%PDF-1.7"]) }, "Test");
  assert.equal(ok, false);
  assert.equal(urlDownloads, 0);
});

await test("HEAD-only PDF result uses one guarded GET and no native URL import", async () => {
  let attached = false;
  let guardedGets = 0;
  let nativeImports = 0;
  const blob = new Blob(["%PDF-1.7\nfixture"], { type: "application/pdf" });
  const context = vm.createContext({
    OS: { Path: { join: (...parts) => parts.join("/") }, File: {
      remove: async () => {}, removeDir: async () => {}
    } },
    ZotFetchPrefs: { getRequestTimeoutMs: () => 5000 },
    Utils: { isSafeDestinationURL: () => true, urlForLog: () => "example.org",
      errorForLog: () => "NetworkError", getDomain: () => "example.org",
      getStealthHeaders: () => ({}), safeRequest: async () => {
        guardedGets++;
        return { response: blob, getResponseHeader: () => "application/pdf" };
      } },
    ZotFetch: { hasPDF: async () => attached, cooldown: {
      markDomainSuccess() {}, markDomainNonCaptcha() {}
    } },
    Zotero: { debug() {}, File: { putContentsAsync: async () => {} },
      Attachments: {
        createTemporaryStorageDirectory: async () => ({ path: "temporary" }),
        createURLAttachmentFromTemporaryStorageDirectory: async () => { attached = true; },
        importFromURL: async () => { nativeImports++; }
      }
    }
  });
  vm.runInContext(source("chrome/content/importer.mjs"), context);
  assert.equal(await context.AttachmentImporter.importResolvedPdf(
    { id: 1, libraryID: 1 }, { ok: true, finalPdfUrl: "https://example.org/a.pdf" }, "Test"), true);
  assert.equal(guardedGets, 1);
  assert.equal(nativeImports, 0);
});

await test("Sci-PDF fallback invokes Zotero custom method only for active Sci-PDF resolvers", async () => {
  let active = true;
  let attached = false;
  let calls = 0;
  let configured = [{ name: "Sci-Hub", method: "GET", mode: "html", selector: "#pdf",
    attribute: "src", url: "https://sci-hub.example/{doi}" }];
  const context = vm.createContext({
    CooldownManager: class {},
    ProtectedHosts: { ProtectedHostNegativeCache: class {}, ItemHostAttemptTracker: class {} },
    ChromeUtils: { importESModule: () => ({ AddonManager: {
      getAddonByID: async id => id === "scipdf@ytshen.com" ? { isActive: active } : null
    } }) },
    Utils: { isSafeNetworkURL: url => url.startsWith("https://") },
    Zotero: { debug() {}, Prefs: { get: () => JSON.stringify(configured) },
      Attachments: { canFindFileForItem: () => true,
        addAvailableFile: async (_item, options) => {
          assert.deepEqual(Array.from(options.methods), ["custom"]);
          calls++;
          attached = true;
        } } }
  });
  vm.runInContext(source("chrome/content/fetch.mjs"), context);
  context.ZotFetch.hasPDF = async () => attached;
  const item = { id: 1 };
  assert.equal(await context.ZotFetch._trySciPdfCustom(item, { doi: "10.1/test" }), true);
  assert.equal(calls, 1);
  active = false;
  attached = false;
  assert.equal(await context.ZotFetch._trySciPdfCustom(item, { doi: "10.1/test" }), false);
  assert.equal(calls, 1);
  active = true;
  configured.push({ name: "Other service", method: "GET", mode: "html",
    selector: "a", attribute: "href", url: "https://other.example/{doi}" });
  assert.equal(await context.ZotFetch._trySciPdfCustom(item, { doi: "10.1/test" }), false);
  assert.equal(calls, 1);
  configured = [{ name: "Sci-Hub", method: 7, mode: "html", selector: "#pdf",
    attribute: "src", url: "https://sci-hub.example/{doi}" }];
  assert.equal(await context.ZotFetch._trySciPdfCustom(item, { doi: "10.1/test" }), false);
  assert.equal(calls, 1);
});

await test("Sci-PDF native success is counted without running a second fallback", async () => {
  const context = vm.createContext({
    CooldownManager: class {},
    ProtectedHosts: { ProtectedHostNegativeCache: class {}, ItemHostAttemptTracker: class {} },
    IdentifierExtractor: { fromItem: async () => ({ doi: "10.1/test" }) },
    Zotero: { debug() {} }
  });
  vm.runInContext(source("chrome/content/fetch.mjs"), context);
  context.ZotFetch.hasPDF = async () => false;
  context.ZotFetch._buildSourceResolvers = () => [];
  context.ZotFetch._buildPdfResolvers = () => [];
  context.ZotFetch._trySciPdfCustom = async () => true;
  const stats = { downloaded: 0, scihub: 0, doiRecovered: 0, notFound: 0 };
  const result = await context.ZotFetch.processItem({ id: 1 }, stats, "fast");
  assert.equal(result, "scipdf-native");
  assert.equal(stats.downloaded, 1);
  assert.equal(stats.scihub, 1);
  assert.equal(stats.notFound, 0);
});

await test("Sci-PDF fallback does not repeat a challenged Sci-Hub host", async () => {
  let nativeCalls = 0;
  const context = vm.createContext({
    CooldownManager: class {},
    ProtectedHosts: { ProtectedHostNegativeCache: class { has() { return false; } },
      ItemHostAttemptTracker: class {}, getHostPolicy: () => null },
    IdentifierExtractor: { fromItem: async () => ({ doi: "10.1/test" }) },
    Utils: { getDomain: () => "sci-hub.example" },
    Zotero: { debug() {} }
  });
  vm.runInContext(source("chrome/content/fetch.mjs"), context);
  context.ZotFetch.hasPDF = async () => false;
  context.ZotFetch._buildSourceResolvers = () => [];
  context.ZotFetch._buildPdfResolvers = () => [];
  context.ZotFetch._candidateStream = async function* () {
    yield { sourceId: "scihub", kind: "landing-page", url: "https://sci-hub.example/10.1/test" };
  };
  context.ZotFetch._resolveCandidate = async () => ({ ok: false, failureReason: "captcha" });
  context.ZotFetch._trySciPdfCustom = async () => { nativeCalls++; return true; };
  const stats = { downloaded: 0, scihub: 0, doiRecovered: 0, notFound: 0 };
  const result = await context.ZotFetch.processItem({ id: 1 }, stats, "fast");
  assert.equal(result, "deferred");
  assert.equal(nativeCalls, 0);
});

process.stdout.write(`${passed} regression tests passed\n`);
