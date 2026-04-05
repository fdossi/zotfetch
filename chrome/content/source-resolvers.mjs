// chrome/content/source-resolvers.mjs
// SourceResolver implementations — each resolver knows one access route and
// returns an array of SourceCandidates describing where to look for a PDF.
//
// SourceCandidate shape:
//   sourceId  {string}  – unique resolver id
//   label     {string}  – human-readable label for UI/logs
//   url       {string}  – URL to attempt
//   kind      {"direct-pdf"|"landing-page"|"api-result"}
//   priority  {number}  – higher = tried first
//   headers?  {Object}  – extra request headers
//   meta?     {Object}  – extra data passed to the PDF resolver

// ─────────────────────────────────────────────────────────────────────────────
// Helper: determine whether a URL looks like a direct PDF link.
// ─────────────────────────────────────────────────────────────────────────────
function _looksLikePdf(url) {
  return /\.pdf(\?|#|$)/i.test(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// NativeSourceResolver
// Delegates to Zotero's own OA finder. Produces a sentinel candidate that
// tells the pipeline to call ZotFetch.tryNative() rather than going through a
// URL — the AttachmentImporter handles this special kind.
// ─────────────────────────────────────────────────────────────────────────────
var NativeSourceResolver = class {
  constructor() { this.id = "native"; }

  enabled() { return true; }

  async buildCandidates(_item, _ids) {
    return [{
      sourceId: "native",
      label: "Zotero Native",
      url: "",            // empty — handled by NativeAttachmentImporter sentinel
      kind: "api-result",
      priority: 110
    }];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UnpaywallSourceResolver
// Queries the Unpaywall API for OA PDF locations.
// ─────────────────────────────────────────────────────────────────────────────
var UnpaywallSourceResolver = class {
  constructor() { this.id = "unpaywall"; }

  enabled() { return !!ZotFetchPrefs.getUnpaywallEmail(); }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];

    const email = ZotFetchPrefs.getUnpaywallEmail();
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(ids.doi)}?email=${encodeURIComponent(email)}`;

    try {
      const resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: ZotFetchPrefs.getUnpaywallTimeoutMs()
      });

      const data = resp.response;
      const rawUrls = ZotFetch.getUnpaywallPDFs(data);

      // Sort: direct-PDF hosts first; safe OA hosts before unknown ones.
      const candidates = rawUrls.map((u, i) => ({
        sourceId: "unpaywall",
        label: "Unpaywall",
        url: u,
        kind: _looksLikePdf(u) ? "direct-pdf" : "landing-page",
        priority: 100 - i,
        headers: { Referer: "https://unpaywall.org/" }
      }));

      candidates.sort((a, b) => {
        const sa = ZotFetch.isSafeOAHost(Utils.getDomain(a.url)) ? 1 : 0;
        const sb = ZotFetch.isSafeOAHost(Utils.getDomain(b.url)) ? 1 : 0;
        return sb - sa;
      });

      return candidates;
    } catch (error) {
      if (Utils.isCaptchaError(error)) {
        ZotFetch.cooldown.markDomainCaptcha("api.unpaywall.org");
      } else {
        ZotFetch.cooldown.markDomainNonCaptcha("api.unpaywall.org");
      }
      Zotero.logError(error);
      return [];
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// SemanticScholarSourceResolver
// Uses the Semantic Scholar Graph API to obtain an open-access PDF URL.
// ─────────────────────────────────────────────────────────────────────────────
var SemanticScholarSourceResolver = class {
  constructor() { this.id = "semanticscholar"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];

    const domain = "api.semanticscholar.org";
    if (ZotFetch.cooldown.isDomainCoolingDown(domain)) return [];
    await ZotFetch.cooldown.honorDomainGap(domain, ZotFetchPrefs);

    try {
      const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(ids.doi)}?fields=openAccessPdf`;
      const resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: 10000,
        headers: { "User-Agent": "ZotFetch/1.2 (mailto:zotfetch@gmail.com)" }
      });

      const pdfUrl = resp.response?.openAccessPdf?.url;
      if (!pdfUrl) {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
        return [];
      }

      ZotFetch.cooldown.markDomainSuccess(domain);
      return [{
        sourceId: "semanticscholar",
        label: "Semantic Scholar",
        url: pdfUrl,
        kind: _looksLikePdf(pdfUrl) ? "direct-pdf" : "landing-page",
        priority: 95
      }];
    } catch (error) {
      ZotFetch.cooldown.markDomainNonCaptcha(domain);
      Zotero.logError(error);
      return [];
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// OpenAlexSourceResolver
// Uses the OpenAlex API to obtain an open-access PDF URL.
// ─────────────────────────────────────────────────────────────────────────────
var OpenAlexSourceResolver = class {
  constructor() { this.id = "openalex"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];

    const domain = "api.openalex.org";
    if (ZotFetch.cooldown.isDomainCoolingDown(domain)) return [];
    await ZotFetch.cooldown.honorDomainGap(domain, ZotFetchPrefs);

    try {
      const email = ZotFetchPrefs.getUnpaywallEmail();
      const url = `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(ids.doi)}?select=open_access,best_oa_location&mailto=${encodeURIComponent(email)}`;
      const resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: 10000
      });

      const data = resp.response;
      const pdfUrl = data?.best_oa_location?.pdf_url ||
        (String(data?.open_access?.oa_url || "").toLowerCase().includes(".pdf")
          ? data.open_access.oa_url : null);

      if (!pdfUrl) {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
        return [];
      }

      ZotFetch.cooldown.markDomainSuccess(domain);
      return [{
        sourceId: "openalex",
        label: "OpenAlex",
        url: pdfUrl,
        kind: _looksLikePdf(pdfUrl) ? "direct-pdf" : "landing-page",
        priority: 90
      }];
    } catch (error) {
      ZotFetch.cooldown.markDomainNonCaptcha(domain);
      Zotero.logError(error);
      return [];
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// OaRepositorySourceResolver
// Uses the item URL field when it points to a known safe OA host.
// ─────────────────────────────────────────────────────────────────────────────
var OaRepositorySourceResolver = class {
  constructor() { this.id = "oa-repository"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    const url = ids.url;
    if (!url || !url.startsWith("http")) return [];
    // Only use the URL field — not the DOI-derived https://doi.org/ URL.
    if (url.startsWith("https://doi.org/")) return [];

    const domain = Utils.getDomain(url);
    if (!domain || !ZotFetch.isSafeOAHost(domain)) return [];

    return [{
      sourceId: "oa-repository",
      label: "OA Repository",
      url,
      kind: _looksLikePdf(url) ? "direct-pdf" : "landing-page",
      priority: 85
    }];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DoiLandingSourceResolver
// Follows the canonical DOI resolver, which redirects to the publisher page.
// We mark it as a landing-page so HtmlLandingPDFResolver will extract the PDF.
// ─────────────────────────────────────────────────────────────────────────────
var DoiLandingSourceResolver = class {
  constructor() { this.id = "doi-landing"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];
    return [{
      sourceId: "doi-landing",
      label: "DOI Landing",
      url: `https://doi.org/${encodeURIComponent(ids.doi)}`,
      kind: "landing-page",
      priority: 80,
      headers: { Referer: "https://doi.org/" }
    }];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// InstitutionalProxySourceResolver
// Routes DOI through the configured institutional proxy and optionally through
// Semantic Scholar for additional resolution hints.
// ─────────────────────────────────────────────────────────────────────────────
var InstitutionalProxySourceResolver = class {
  constructor() { this.id = "institutional-proxy"; }

  enabled() { return ZotFetchPrefs.isInstitutionalProxyEnabled(); }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];

    const proxyBase = ZotFetchPrefs.getInstitutionalProxyUrl();
    if (!proxyBase || !proxyBase.trim()) return [];

    const doiTarget = `https://doi.org/${encodeURIComponent(ids.doi)}`;
    const proxied = ZotFetch.buildProxyTargetURL(proxyBase, doiTarget);

    const candidates = [{
      sourceId: "institutional-proxy",
      label: "Institutional Proxy",
      url: proxied,
      kind: "landing-page",
      priority: 75,
      headers: {
        Referer: "https://scholar.google.com/",
        ...Utils.getStealthHeaders()
      }
    }];

    // Secondary: route Semantic Scholar's PDF URL through the proxy as well
    // so authenticated users can download from S2 PDFs behind the proxy.
    // We add it as a lower-priority variant.
    const s2Domain = "pdfs.semanticscholar.org";
    if (!ZotFetch.cooldown.isDomainCoolingDown(s2Domain)) {
      try {
        const email = ZotFetchPrefs.getUnpaywallEmail();
        const s2url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(ids.doi)}?fields=openAccessPdf`;
        const resp = await Zotero.HTTP.request("GET", s2url, {
          responseType: "json",
          timeout: 8000,
          headers: { "User-Agent": "ZotFetch/1.2 (mailto:" + email + ")" }
        });
        const pdfUrl = resp.response?.openAccessPdf?.url;
        if (pdfUrl) {
          const proxiedS2 = ZotFetch.buildProxyTargetURL(proxyBase, pdfUrl);
          candidates.push({
            sourceId: "institutional-proxy-s2",
            label: "Institutional Proxy (S2)",
            url: proxiedS2,
            kind: "landing-page",
            priority: 72,
            headers: {
              Referer: "https://www.semanticscholar.org/",
              ...Utils.getStealthHeaders()
            }
          });
        }
      } catch (_) { /* best effort */ }
    }

    return candidates;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CapesSourceResolver
// Routes DOI through the CAPES portal proxy (Brazil).
// ─────────────────────────────────────────────────────────────────────────────
var CapesSourceResolver = class {
  constructor() { this.id = "capes"; }

  enabled() { return ZotFetchPrefs.isCapesEnabled(); }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];

    const proxy = ZotFetchPrefs.getProxyUrl();
    const doiTarget = `https://doi.org/${encodeURIComponent(ids.doi)}`;
    const url = proxy ? ZotFetch.buildProxyTargetURL(proxy, doiTarget) : doiTarget;

    return [{
      sourceId: "capes",
      label: "CAPES",
      url,
      kind: "landing-page",
      priority: 70,
      headers: {
        Referer: "https://scholar.google.com/",
        ...Utils.getStealthHeaders()
      }
    }];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ScihubSourceResolver
// Constructs Sci-Hub landing page candidates for each mirror.
// The HTML page embeds the real PDF URL which is extracted by ScihubPDFResolver.
// NOTE: Sci-Hub is provided as a fallback for regions/institutions where it
// is the only practical option. Enable only via the preferences toggle.
// ─────────────────────────────────────────────────────────────────────────────
var ScihubSourceResolver = class {
  constructor() { this.id = "scihub"; }

  enabled() { return ZotFetchPrefs.isScihubEnabled(); }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];

    const mirrors = [
      "sci-hub.se",
      "sci-hub.st",
      "sci-hub.ru",
      "sci-hub.it",
      "sci-hub.cat",
      "sci-hub.ren",
      "sci-hub.hkvisa.net",
      "sci-hub.usualwant.com",
      "sci-hub.41849.com",
      "sci-hub.p2p.cx"
    ];

    const maxMirrors = Number.isFinite(ZotFetchPrefs.getFastMirrorLimit())
      ? ZotFetchPrefs.getFastMirrorLimit()
      : mirrors.length;

    return mirrors
      .filter(m => !ZotFetch.cooldown.isDomainCoolingDown(m))
      .slice(0, maxMirrors)
      .map((mirror, i) => ({
        sourceId: "scihub",
        label: "Sci-Hub",
        url: `https://${mirror}/${ids.doi}`,
        kind: "landing-page",
        priority: 60 - i,
        meta: { scihub: true, mirror },
        headers: {
          ...Utils.getStealthHeaders(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: "https://www.google.com/"
        }
      }));
  }
};

this.NativeSourceResolver = NativeSourceResolver;
this.UnpaywallSourceResolver = UnpaywallSourceResolver;
this.SemanticScholarSourceResolver = SemanticScholarSourceResolver;
this.OpenAlexSourceResolver = OpenAlexSourceResolver;
this.OaRepositorySourceResolver = OaRepositorySourceResolver;
this.DoiLandingSourceResolver = DoiLandingSourceResolver;
this.InstitutionalProxySourceResolver = InstitutionalProxySourceResolver;
this.CapesSourceResolver = CapesSourceResolver;
this.ScihubSourceResolver = ScihubSourceResolver;
