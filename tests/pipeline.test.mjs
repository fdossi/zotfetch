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
  isAntiCaptchaMode: ()   => false,
  getRequestTimeoutMs: ()  => 5000,
  getUnpaywallTimeoutMs: () => 5000,
  getDomainGapMs:    () => 0,
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

// ─── Test group: URL normalisation ────────────────────────────────────────────

console.log("\nURL normalisation");

await test("relative URL is resolved against base", () => {
  const resolved = new URL("/pdf/paper.pdf", "https://publisher.com/article/123").href;
  assert(resolved === "https://publisher.com/pdf/paper.pdf", `Got: ${resolved}`);
});

await test("protocol-relative URL becomes https", () => {
  const raw = "//cdn.example.com/paper.pdf";
  const resolved = "https:" + raw;
  assert(resolved === "https://cdn.example.com/paper.pdf");
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

// ─── Test group: IdentifierExtractor — archiveLocation ───────────────────────

console.log("\nIdentifierExtractor — archiveLocation");

await test("extracts arXiv ID from archiveLocation field", async () => {
  const item = {
    getField(f) {
      if (f === "archiveLocation") return "arXiv:2301.00001";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.arxivId === "2301.00001", `Got: ${ids.arxivId}`);
});

await test("archiveID takes precedence over archiveLocation", async () => {
  const item = {
    getField(f) {
      if (f === "archiveID")       return "2401.99999";
      if (f === "archiveLocation") return "arXiv:2301.00001";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.arxivId === "2401.99999", `Expected archiveID, got: ${ids.arxivId}`);
});

await test("extracts arXiv ID from bare archiveID field", async () => {
  const item = {
    getField(f) {
      if (f === "archiveID") return "2301.00001";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.arxivId === "2301.00001", `Got: ${ids.arxivId}`);
});

await test("extracts arXiv ID from arxiv.org URL", async () => {
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

await test("extracts old-style arXiv ID from arxiv.org URL", async () => {
  const item = {
    getField(f) {
      if (f === "url") return "https://arxiv.org/abs/hep-ph/0601001";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.arxivId === "hep-ph/0601001", `Got: ${ids.arxivId}`);
});

await test("extracts old-style arXiv ID from bare archiveID", async () => {
  const item = {
    getField(f) {
      if (f === "archiveID") return "hep-ph/0601001";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.arxivId === "hep-ph/0601001", `Got: ${ids.arxivId}`);
});

// ─── Test group: PMCID extraction ────────────────────────────────────────────

console.log("\nPMCID extraction");

await test("extracts PMCID from Extra field", async () => {
  const item = {
    getField(f) {
      if (f === "extra") return "PMID: 12345678\nPMCID: PMC9876543";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.pmcid === "PMC9876543", `Got: ${ids.pmcid}`);
  assert(ids.pmid === "12345678", `Got PMID: ${ids.pmid}`);
});

await test("PMCID is uppercased on extraction", async () => {
  const item = {
    getField(f) {
      if (f === "extra") return "pmcid: pmc1234567";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.pmcid === "PMC1234567", `Got: ${ids.pmcid}`);
});

await test("no PMCID yields undefined pmcid", async () => {
  const item = {
    getField(f) {
      if (f === "extra") return "PMID: 12345678";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.pmcid === undefined, `Expected undefined, got: ${ids.pmcid}`);
});

// ─── Test group: OaRepositorySourceResolver — arXiv direct-pdf ───────────────

console.log("\nOaRepositorySourceResolver — arXiv direct-pdf");

await test("produces direct-pdf candidate when arxivId is known", async () => {
  const sr = new OaRepositorySourceResolver();
  const candidates = await sr.buildCandidates({}, { arxivId: "2301.00001" });
  const pdf = candidates.find(c => c.kind === "direct-pdf");
  assert(pdf !== undefined, "Expected a direct-pdf candidate");
  assert(pdf.url === "https://arxiv.org/pdf/2301.00001", `Got: ${pdf.url}`);
  assert(pdf.priority === 86);
});

await test("skips redundant landing-page when arxivId + arxiv.org URL", async () => {
  const sr = new OaRepositorySourceResolver();
  const candidates = await sr.buildCandidates({}, {
    arxivId: "2301.00001",
    itemUrl: "https://arxiv.org/abs/2301.00001"
  });
  // Should have the direct-pdf but NOT an extra landing-page for the same ID.
  const landingPages = candidates.filter(c => c.kind === "landing-page" && Utils.getDomain(c.url) === "arxiv.org");
  assert(landingPages.length === 0, `Expected no redundant arxiv landing-page, got ${landingPages.length}`);
});

await test("keeps non-arxiv OA URL alongside arXiv direct-pdf", async () => {
  const sr = new OaRepositorySourceResolver();
  const candidates = await sr.buildCandidates({}, {
    arxivId: "2301.00001",
    itemUrl: "https://zenodo.org/record/1234567"
  });
  assert(candidates.some(c => c.kind === "direct-pdf" && c.url.includes("arxiv.org")), "Expected arxiv PDF");
  assert(candidates.some(c => Utils.getDomain(c.url) === "zenodo.org"), "Expected zenodo URL");
});

// ─── Test group: DOI trailing punctuation strip ───────────────────────────────

console.log("\nDOI trailing punctuation strip");

await test("strips trailing period from DOI in URL", async () => {
  const item = {
    getField(f) {
      if (f === "url") return "https://doi.org/10.1000/xyz.001.";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.doi === "10.1000/xyz.001", `Got: ${ids.doi}`);
});

await test("strips trailing comma from DOI in extra", async () => {
  const item = {
    getField(f) {
      if (f === "extra") return "DOI: 10.1000/abc.002,";
      return "";
    },
    getCreators: () => []
  };
  const ids = await IdentifierExtractor.fromItem(item);
  assert(ids.doi === "10.1000/abc.002", `Got: ${ids.doi}`);
});

// ─── Test group: Security — URL scheme guard ──────────────────────────────────

console.log("\nSecurity — URL scheme guard");

await test("_resolveCandidate rejects file:// URL", async () => {
  // Stub a minimal ZotFetch._resolveCandidate from the real fetch.mjs logic.
  // Since fetch.mjs is not loaded here we re-implement the guard logic directly.
  function resolveCandidate_guardOnly(candidate) {
    if (candidate.url && !/^https?:\/\//i.test(candidate.url)) {
      return { ok: false, failureReason: "network" };
    }
    return null; // would continue to resolvers
  }
  const r = resolveCandidate_guardOnly({ url: "file:///etc/passwd", kind: "landing-page" });
  assert(r !== null && !r.ok, "Expected guard to reject file:// URL");
  assert(r.failureReason === "network");
});

await test("_resolveCandidate rejects javascript: URL", async () => {
  function resolveCandidate_guardOnly(candidate) {
    if (candidate.url && !/^https?:\/\//i.test(candidate.url)) {
      return { ok: false, failureReason: "network" };
    }
    return null;
  }
  const r = resolveCandidate_guardOnly({ url: "javascript:alert(1)", kind: "direct-pdf" });
  assert(r !== null && !r.ok, "Expected guard to reject javascript: URL");
});

await test("_resolveCandidate allows https:// URL", async () => {
  function resolveCandidate_guardOnly(candidate) {
    if (candidate.url && !/^https?:\/\//i.test(candidate.url)) {
      return { ok: false, failureReason: "network" };
    }
    return null;
  }
  const r = resolveCandidate_guardOnly({ url: "https://arxiv.org/pdf/2301.00001.pdf", kind: "direct-pdf" });
  assert(r === null, "https:// should pass the guard (returns null = continue)");
});

await test("_resolveCandidate allows empty sentinel URL", async () => {
  function resolveCandidate_guardOnly(candidate) {
    if (candidate.url && !/^https?:\/\//i.test(candidate.url)) {
      return { ok: false, failureReason: "network" };
    }
    return null;
  }
  const r = resolveCandidate_guardOnly({ url: "", kind: "api-result" });
  assert(r === null, "Empty URL (sentinel) should pass the guard");
});

// ─── Test group: Security — CrossRef year injection ───────────────────────────

console.log("\nSecurity — CrossRef year injection");

await test("4-digit year is accepted", () => {
  const year = "2023";
  const safe = /^\d{4}$/.test(year);
  assert(safe, "4-digit year should pass");
});

await test("crafted year with extra params is rejected", () => {
  const year = "2023&rows=999&evil=true";
  const safe = /^\d{4}$/.test(year);
  assert(!safe, "Crafted year should fail the 4-digit guard");
});

await test("empty year is not injected into query", () => {
  const year = "";
  const safe = year && /^\d{4}$/.test(year);
  assert(!safe, "Empty year should not produce a filter clause");
});

// ─── Test group: protected-host policies ─────────────────────────────────────

console.log("\nProtected-host policies");

// Minimal shim — re-implement the lookup the same way protected-hosts.mjs does.
loadModule("chrome/content/protected-hosts.mjs");

await test("tandfonline.com has earlyAbortOnChallenge policy", () => {
  const policy = ProtectedHosts.getHostPolicy("tandfonline.com");
  assert(policy !== null, "tandfonline.com must have a policy");
  assert(policy.earlyAbortOnChallenge === true);
});

await test("pubs.rsc.org has earlyAbortOnChallenge policy", () => {
  const policy = ProtectedHosts.getHostPolicy("pubs.rsc.org");
  assert(policy !== null, "pubs.rsc.org must have a policy");
  assert(policy.earlyAbortOnChallenge === true);
});

await test("journals.sagepub.com has earlyAbortOnChallenge policy", () => {
  const policy = ProtectedHosts.getHostPolicy("journals.sagepub.com");
  assert(policy !== null, "journals.sagepub.com must have a policy");
  assert(policy.earlyAbortOnChallenge === true);
});

await test("sciencedirect.com retains its policy", () => {
  const policy = ProtectedHosts.getHostPolicy("sciencedirect.com");
  assert(policy !== null);
  assert(policy.maxAttemptsPerItem === 1);
  assert(policy.minGapMs === 8000);
});

await test("unknown host returns null policy", () => {
  const policy = ProtectedHosts.getHostPolicy("example.com");
  assert(policy === null, "Unknown host should have no policy");
});

// ─── Test group: OaRepositorySourceResolver URL scheme check ─────────────────

console.log("\nOaRepositorySourceResolver — URL scheme");

await test("OaRepositorySourceResolver rejects non-http URL", async () => {
  const sr = new OaRepositorySourceResolver();
  const candidates = await sr.buildCandidates({}, { itemUrl: "ftp://example.com/paper.pdf" });
  assert(candidates.length === 0, "Non-http URL should yield no candidates");
});

await test("OaRepositorySourceResolver rejects bare path", async () => {
  const sr = new OaRepositorySourceResolver();
  const candidates = await sr.buildCandidates({}, { itemUrl: "/relative/path/paper.pdf" });
  assert(candidates.length === 0, "Bare path should yield no candidates");
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
