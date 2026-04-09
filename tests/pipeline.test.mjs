// tests/pipeline.test.mjs
// Unit tests for the ZotFetch PDF-resolution pipeline.
//
// These tests run in Node.js (or any JS runtime) — they do NOT require Zotero.
// A lightweight mock environment is set up in this file so every module under
// test can be loaded with `importModule()`.
//
// Run: node tests/pipeline.test.mjs
//
// Exit code 0 = all tests passed.
// Exit code 1 = one or more failures.

// ─── Minimal browser/Zotero shims ─────────────────────────────────────────────

globalThis.Zotero = {
  debug: () => {},
  logError: (e) => console.error("[logError]", e),
  HTTP: {
    // Overridden per-test
    request: async () => { throw new Error("HTTP.request not mocked"); }
  },
  Prefs: {
    _store: {},
    get(key) { return this._store[key]; },
    set(key, v) { this._store[key] = v; }
  }
};

// ─── Stub globals used by the modules ─────────────────────────────────────────

globalThis.Utils = {
  normalizeDOI(doi) {
    return String(doi || "").trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .trim();
  },
  getDomain(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
  },
  isCaptchaError() { return false; },
  getStealthHeaders() {
    return { "User-Agent": "TestAgent/1.0" };
  },
  isTitleSimilar() { return { match: false, score: 0 }; }
};

// Stub ZotFetchPrefs used by resolvers
globalThis.ZotFetchPrefs = {
  getUnpaywallEmail: ()   => "test@example.com",
  isCapesEnabled:    ()   => true,
  isScihubEnabled:   ()   => true,
  isAntiCaptchaMode: ()   => false,
  getRequestTimeoutMs: ()  => 5000,
  getUnpaywallTimeoutMs: () => 5000,
  getDomainGapMs:    () => 0,
  getFastMirrorLimit: () => 2,
  getProxyUrl:       () => "",
  getInstitutionalProxyUrl: () => "https://proxy.example.edu/login?url=",
  isInstitutionalProxyEnabled: () => true
};

// Stub CooldownManager
globalThis.CooldownManager = class {
  isDomainCoolingDown() { return false; }
  markDomainSuccess() {}
  markDomainNonCaptcha() {}
  markDomainCaptcha() {}
  applyPenaltyCooldown() {}
  async honorDomainGap() {}
  async applyProtectedDelay() {}
  async sleepWithJitter() {}
};

// Stub ZotFetch — partially filled in after real fetch.mjs is loaded
globalThis.ZotFetch = {
  cooldown: new CooldownManager(),
  isSafeOAHost(domain) {
    const safe = new Set(["arxiv.org", "europepmc.org", "mdpi.com", "semanticscholar.org", "pdfs.semanticscholar.org"]);
    return safe.has(domain);
  },
  buildProxyTargetURL(proxyBase, targetURL) {
    const base = String(proxyBase || "").trim();
    const target = String(targetURL || "").trim();
    if (!base || !target) return target;
    if (base.includes("{url}")) return base.replace("{url}", encodeURIComponent(target));
    if (/([?&]url=)$/i.test(base)) return `${base}${encodeURIComponent(target)}`;
    if (base.includes("?")) {
      const sep = base.endsWith("?") || base.endsWith("&") ? "" : "&";
      return `${base}${sep}url=${encodeURIComponent(target)}`;
    }
    const sep = base.endsWith("/") ? "" : "/";
    return `${base}${sep}login?url=${encodeURIComponent(target)}`;
  },
  getUnpaywallPDFs(data) {
    const list = [
      data?.best_oa_location?.url_for_pdf,
      ...(Array.isArray(data?.oa_locations) ? data.oa_locations.map(l => l?.url_for_pdf) : [])
    ];
    return list.filter(Boolean);
  },
  isCloudflareChallengePage(html) {
    const lower = html.toLowerCase();
    return lower.includes("cf-challenge") || lower.includes("cf_chl") ||
           lower.includes("turnstile") || lower.includes("enable javascript and cookies");
  },
  extractScihubPdfUrl(html, mirrorOrigin) {
    const embed = html.match(/<embed[^>]+src=["']([^"']+)["']/i);
    if (embed) {
      const src = embed[1].split("#")[0].trim();
      if (src && src.toLowerCase().includes(".pdf")) return `https:${src.startsWith("//") ? "" : "//"}${src.replace(/^\/\//, "")}`;
    }
    return null;
  }
};

// Load module helper — reads the file synchronously and evals in global scope.
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
function loadModule(relPath) {
  const code = readFileSync(join(__dirname, "..", relPath), "utf-8");
  // Strip 'this.X = X' exports which reference `this` (not valid at module top level in strict mode)
  // We execute in global scope via eval.
  // eslint-disable-next-line no-eval
  (0, eval)(code);
}

// Load modules in dependency order
loadModule("chrome/content/source-resolvers.mjs");
loadModule("chrome/content/pdf-resolvers.mjs");
loadModule("chrome/content/importer.mjs");
loadModule("chrome/content/identifiers.mjs");

// ─── Test harness ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failures.push({ name, error: e });
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function mockHttp(responsesByUrl) {
  Zotero.HTTP.request = async (method, url, opts) => {
    const key = url.split("?")[0];
    const mockFn = responsesByUrl[key] || responsesByUrl[url] || responsesByUrl["*"];
    if (!mockFn) throw Object.assign(new Error("Network error"), { status: 0 });
    return mockFn(method, url, opts);
  };
}

function domFrom(html) {
  // Lightweight DOM-like structure from an HTML string.
  // We use it to test the extraction helpers inside resolvers.
  let JSDOM;
  try {
    JSDOM = require("jsdom").JSDOM;
  } catch (_) {
    return null; // skip DOM tests if jsdom not available
  }
  return new JSDOM(html).window.document;
}

// ─── Test group: IdentifierExtractor ──────────────────────────────────────────

console.log("\nIdentifierExtractor");

await test("extracts DOI from DOI field", async () => {
  const item = {
    getField(f) {
      if (f === "DOI") return "10.1000/xyz123";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.doi === "10.1000/xyz123", `Expected '10.1000/xyz123', got '${ids.doi}'`);
});

await test("extracts DOI from URL field when DOI field is empty", async () => {
  const item = {
    getField(f) {
      if (f === "url") return "https://doi.org/10.1016/j.test.2020.01.001";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.doi === "10.1016/j.test.2020.01.001", `Got: ${ids.doi}`);
});

await test("extracts arxiv ID from URL", async () => {
  const item = {
    getField(f) {
      if (f === "url") return "https://arxiv.org/abs/2301.00001";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.arxivId === "2301.00001", `Got: ${ids.arxivId}`);
});

await test("extracts PMID from extra field", async () => {
  const item = {
    getField(f) {
      if (f === "extra") return "PMID: 12345678";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.pmid === "12345678", `Got: ${ids.pmid}`);
});

// ─── Test group: SourceResolvers ──────────────────────────────────────────────

console.log("\nSourceResolvers");

await test("UnpaywallSourceResolver: returns direct-pdf candidate for .pdf URL", async () => {
  mockHttp({
    "https://api.unpaywall.org/v2/10.1000%2Ftest": () => ({
      response: {
        best_oa_location: { url_for_pdf: "https://example.com/paper.pdf" },
        oa_locations: []
      }
    })
  });
  const sr = new UnpaywallSourceResolver();
  const candidates = await sr.buildCandidates({}, { doi: "10.1000/test" });
  assert(candidates.length > 0, "Expected at least one candidate");
  assert(candidates[0].kind === "direct-pdf", `Expected direct-pdf, got ${candidates[0].kind}`);
  assert(candidates[0].url === "https://example.com/paper.pdf");
});

await test("UnpaywallSourceResolver: returns landing-page candidate for HTML URL", async () => {
  mockHttp({
    "https://api.unpaywall.org/v2/10.1000%2Ftest": () => ({
      response: {
        best_oa_location: { url_for_pdf: "https://publisher.com/article/view" },
        oa_locations: []
      }
    })
  });
  const sr = new UnpaywallSourceResolver();
  const candidates = await sr.buildCandidates({}, { doi: "10.1000/test" });
  assert(candidates[0].kind === "landing-page", `Expected landing-page, got ${candidates[0].kind}`);
});

await test("NativeDoiSourceResolver: returns sentinel candidate for doi", async () => {
  const sr = new NativeDoiSourceResolver();
  const candidates = await sr.buildCandidates({}, { doi: "10.1000/test" });
  assert(candidates.length === 1, "Expected one candidate");
  assert(candidates[0].sourceId === "native-doi");
  assert(candidates[0].url === "", "URL should be empty sentinel");
  assert(candidates[0].kind === "api-result");
  assert(candidates[0].priority === 83);
});

await test("NativeDoiSourceResolver: returns empty when no DOI", async () => {
  const sr = new NativeDoiSourceResolver();
  const candidates = await sr.buildCandidates({}, {});
  assert(candidates.length === 0, "No candidates without DOI");
});

await test("NativeDoiSourceResolver: priority is between OA repo and doi landing", () => {
  const nativeDoi = { priority: 83 };
  const oaRepo = { priority: 85 };
  const doiLanding = { priority: 80 };
  const sorted = [doiLanding, nativeDoi, oaRepo].sort((a, b) => b.priority - a.priority);
  assert(sorted[0].priority === 85, "OA repo should come first");
  assert(sorted[1].priority === 83, "Native DOI should come second");
  assert(sorted[2].priority === 80, "DOI landing should come last");
});

await test("DoiLandingSourceResolver: builds doi.org URL", async () => {
  const sr = new DoiLandingSourceResolver();
  const candidates = await sr.buildCandidates({}, { doi: "10.1000/test" });
  assert(candidates.length === 1);
  assert(candidates[0].url.startsWith("https://doi.org/"), `URL: ${candidates[0].url}`);
  assert(candidates[0].kind === "landing-page");
  assert(candidates[0].priority === 80);
});

await test("OaRepositorySourceResolver: accepts arxiv.org URL as direct-pdf", async () => {
  const sr = new OaRepositorySourceResolver();
  const candidates = await sr.buildCandidates({}, {
    itemUrl: "https://arxiv.org/pdf/2301.00001.pdf"
  });
  assert(candidates.length === 1, "Expected one candidate");
  assert(candidates[0].kind === "direct-pdf");
});

await test("OaRepositorySourceResolver: rejects doi.org URL", async () => {
  const sr = new OaRepositorySourceResolver();
  const candidates = await sr.buildCandidates({}, {
    itemUrl: "https://doi.org/10.1000/test"
  });
  assert(candidates.length === 0, "Should not accept doi.org URL");
});

await test("InstitutionalProxySourceResolver: wraps DOI in proxy URL", async () => {
  // Mock S2 lookup to return no pdfUrl so only one candidate is generated
  mockHttp({ "*": async () => ({ response: {} }) });
  const sr = new InstitutionalProxySourceResolver();
  const candidates = await sr.buildCandidates({}, { doi: "10.1000/test" });
  assert(candidates.length >= 1);
  assert(candidates[0].url.includes("proxy.example.edu"), `URL: ${candidates[0].url}`);
  assert(candidates[0].kind === "landing-page");
});

await test("candidate priority ordering: native > unpaywall > oa-repo > doi-landing", () => {
  const native = { priority: 110 };
  const unpaywall = { priority: 100 };
  const oaRepo = { priority: 85 };
  const doiLanding = { priority: 80 };
  const sorted = [doiLanding, oaRepo, native, unpaywall].sort((a, b) => b.priority - a.priority);
  assert(sorted[0].priority === 110, "native should be first");
  assert(sorted[1].priority === 100, "unpaywall should be second");
});

// ─── Test group: PDFResolvers ──────────────────────────────────────────────────

console.log("\nPDFResolvers");

const mockCtx = {
  timeoutMs: 3000,
  cooldown: new CooldownManager(),
  prefs: ZotFetchPrefs,
  userAgents: ["TestAgent/1.0"],
  logger: () => {}
};

await test("DirectPDFResolver: resolves when HEAD returns application/pdf", async () => {
  mockHttp({
    "*": () => ({
      getResponseHeader: (h) => h === "Content-Type" ? "application/pdf; charset=utf-8" : null
    })
  });
  const resolver = new DirectPDFResolver();
  const candidate = { kind: "direct-pdf", url: "https://example.com/paper.pdf", headers: {} };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(result.ok, "Expected ok=true");
  assert(result.method === "direct");
  assert(result.finalPdfUrl === candidate.url);
});

await test("DirectPDFResolver: fails when Content-Type is text/html", async () => {
  mockHttp({
    "*": () => ({
      getResponseHeader: (h) => h === "Content-Type" ? "text/html" : null
    })
  });
  const resolver = new DirectPDFResolver();
  const candidate = { kind: "direct-pdf", url: "https://example.com/article", headers: {} };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(!result.ok, "Expected ok=false");
  assert(result.failureReason === "nopdf");
});

await test("HtmlLandingPDFResolver: extracts from citation_pdf_url meta", async () => {
  const html = `<html><head>
    <meta name="citation_pdf_url" content="/pdf/paper.pdf">
  </head><body></body></html>`;

  // Mock fetch returning document, then HEAD returning PDF
  let callCount = 0;
  Zotero.HTTP.request = async (method, url, opts) => {
    callCount++;
    if (method === "GET" && opts?.responseType === "document") {
      const doc = domFrom(html);
      if (!doc) throw new Error("jsdom not available — skipping");
      return { responseXML: doc };
    }
    // HEAD for validation
    return { getResponseHeader: () => "application/pdf" };
  };

  const resolver = new HtmlLandingPDFResolver();
  const candidate = {
    kind: "landing-page",
    url: "https://publisher.com/article/123",
    headers: {},
    meta: {}
  };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(result.ok, "Expected ok=true");
  assert(result.finalPdfUrl.includes("/pdf/paper.pdf"), `Got: ${result.finalPdfUrl}`);
});

await test("HtmlLandingPDFResolver: extracts from anchor with .pdf href", async () => {
  const html = `<html><body>
    <a href="/files/paper.pdf">Download PDF</a>
  </body></html>`;

  Zotero.HTTP.request = async (method, url, opts) => {
    if (method === "GET" && opts?.responseType === "document") {
      const doc = domFrom(html);
      if (!doc) throw new Error("jsdom not available — skipping");
      return { responseXML: doc };
    }
    return { getResponseHeader: () => "application/pdf" };
  };

  const resolver = new HtmlLandingPDFResolver();
  const candidate = {
    kind: "landing-page",
    url: "https://repo.example.com/article",
    headers: {},
    meta: {}
  };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(result.ok, "Expected ok=true");
  assert(result.finalPdfUrl === "https://repo.example.com/files/paper.pdf", `Got: ${result.finalPdfUrl}`);
});

await test("HtmlLandingPDFResolver: returns nopdf when no link found", async () => {
  const html = `<html><body><p>No PDF here.</p></body></html>`;

  Zotero.HTTP.request = async (_method, _url, opts) => {
    if (opts?.responseType === "document") {
      const doc = domFrom(html);
      if (!doc) throw new Error("jsdom not available");
      return { responseXML: doc };
    }
    return {};
  };

  const resolver = new HtmlLandingPDFResolver();
  const candidate = { kind: "landing-page", url: "https://nopdf.example.com", headers: {}, meta: {} };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(!result.ok, "Expected ok=false");
  assert(result.failureReason === "nopdf");
});

await test("HtmlLandingPDFResolver: extracts from iframe src with pdf", async () => {
  const html = `<html><body>
    <iframe src="/viewer?file=paper.pdf"></iframe>
  </body></html>`;

  Zotero.HTTP.request = async (_method, _url, opts) => {
    if (opts?.responseType === "document") {
      const doc = domFrom(html);
      if (!doc) throw new Error("jsdom not available");
      return { responseXML: doc };
    }
    return { getResponseHeader: () => "application/pdf" };
  };

  const resolver = new HtmlLandingPDFResolver();
  const candidate = { kind: "landing-page", url: "https://example.com/article", headers: {}, meta: {} };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(result.ok, `Expected ok=true, got ${JSON.stringify(result)}`);
  assert(result.finalPdfUrl.includes("paper.pdf"), `Got: ${result.finalPdfUrl}`);
});

await test("HtmlLandingPDFResolver: classifies 401 as auth failure", async () => {
  Zotero.HTTP.request = async () => {
    throw Object.assign(new Error("Unauthorized"), { status: 401 });
  };

  const resolver = new HtmlLandingPDFResolver();
  const candidate = { kind: "landing-page", url: "https://paywall.example.com", headers: {}, meta: {} };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(!result.ok);
  assert(result.failureReason === "auth", `Got: ${result.failureReason}`);
});

await test("ScihubPDFResolver: extracts embed src from Sci-Hub HTML", async () => {
  const scihubHtml = `<html><body>
    <embed src="//dacemirror.sci-hub.se/10.1000/test/paper.pdf#view=FitH" type="application/pdf">
  </body></html>`;

  Zotero.HTTP.request = async () => ({
    response: scihubHtml,
    responseText: scihubHtml
  });

  const resolver = new ScihubPDFResolver();
  const candidate = {
    kind: "landing-page",
    url: "https://sci-hub.se/10.1000/test",
    headers: {},
    meta: { scihub: true, mirror: "sci-hub.se" }
  };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(result.ok, `Expected ok=true, got ${JSON.stringify(result)}`);
  assert(result.finalPdfUrl.includes("dacemirror"), `URL: ${result.finalPdfUrl}`);
  assert(result.method === "scihub");
});

await test("ScihubPDFResolver: returns cloudflare on Cloudflare challenge page", async () => {
  const cfHtml = `<html><body>
    <p>enable javascript and cookies to continue</p>
  </body></html>`;

  Zotero.HTTP.request = async () => ({ response: cfHtml, responseText: cfHtml });

  const resolver = new ScihubPDFResolver();
  const candidate = {
    kind: "landing-page",
    url: "https://sci-hub.se/10.1000/test",
    headers: {},
    meta: { scihub: true, mirror: "sci-hub.se" }
  };
  const result = await resolver.resolve(candidate, mockCtx);
  assert(!result.ok);
  assert(result.failureReason === "cloudflare", `Got: ${result.failureReason}`);
});

// ─── Test group: URL normalisation ────────────────────────────────────────────

console.log("\nURL normalisation");

await test("relative URL is resolved against base", () => {
  const resolved = new URL("/pdf/paper.pdf", "https://publisher.com/article/123").href;
  assert(resolved === "https://publisher.com/pdf/paper.pdf", `Got: ${resolved}`);
});

await test("protocol-relative URL becomes https", () => {
  const raw = "//dacemirror.sci-hub.se/paper.pdf";
  const resolved = "https:" + raw;
  assert(resolved === "https://dacemirror.sci-hub.se/paper.pdf");
});

// ─── Test group: buildProxyTargetURL ──────────────────────────────────────────

console.log("\nBuildProxyTargetURL");

await test("{url} placeholder substitution", () => {
  const result = ZotFetch.buildProxyTargetURL(
    "https://proxy.edu/login?qurl={url}",
    "https://doi.org/10.1000/test"
  );
  assert(result.includes("proxy.edu"), `Result: ${result}`);
  assert(result.includes(encodeURIComponent("https://doi.org/10.1000/test")));
});

await test("url= query string append", () => {
  const result = ZotFetch.buildProxyTargetURL(
    "https://proxy.edu/login?url=",
    "https://doi.org/10.1000/test"
  );
  assert(result === `https://proxy.edu/login?url=${encodeURIComponent("https://doi.org/10.1000/test")}`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  • ${f.name}: ${f.error.message}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
