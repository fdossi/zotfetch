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
// DOI prefix → canonical publisher hostname.
// Used to pre-classify doi.org candidates so the protected-host policy in
// fetch.mjs can be applied even before the doi.org redirect is followed.
// Only well-known prefixes that correspond to protected publishers are listed.
// ─────────────────────────────────────────────────────────────────────────────
const _DOI_PREFIX_TO_HOST = {
  "10.1016": "sciencedirect.com",        // Elsevier flagship journals
  "10.1006": "sciencedirect.com",        // Old Elsevier prefix (Academic Press)
  "10.1053": "sciencedirect.com",        // Elsevier clinical journals
  "10.1002": "onlinelibrary.wiley.com",
  "10.1111": "onlinelibrary.wiley.com",  // Wiley-Blackwell
  "10.1007": "link.springer.com",
  "10.1021": "pubs.acs.org",             // ACS Publications
  "10.1039": "pubs.rsc.org",             // Royal Society of Chemistry
  "10.1093": "academic.oup.com",         // Oxford University Press
  "10.1177": "journals.sagepub.com",     // SAGE
  "10.1080": "tandfonline.com"           // Taylor & Francis
};

/**
 * Returns the known canonical publisher hostname for a DOI, or null.
 * Only covers DOI prefixes whose publishers have a protected-host policy.
 * @param {string} doi  normalised DOI without prefix (e.g. "10.1016/j.cell.2023.01.001")
 * @returns {string|null}
 */
function _publisherHostFromDoi(doi) {
  if (!doi) return null;
  for (const [prefix, host] of Object.entries(_DOI_PREFIX_TO_HOST)) {
    if (doi.startsWith(prefix + "/") || doi === prefix) return host;
  }
  return null;
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

  async buildCandidates(_item, ids) {
    // Skip for publishers whose bot-detection immediately blocks Zotero's real
    // UA (reported as "Zotero/8.x" in captcha screens). Zotero's internal OA
    // finder uses that UA and cannot be overridden. Any truly OA copy will be
    // found by ZotFetch's own Unpaywall/S2/OpenAlex pipeline with spoofed
    // browser headers, without triggering a publisher captcha.
    if (ids.doi) {
      const pubHost = _publisherHostFromDoi(ids.doi);
      if (pubHost && ProtectedHosts.getHostPolicy(pubHost)?.earlyAbortOnChallenge) {
        Zotero.debug(`[ZotFetch] NativeSourceResolver: skip ${pubHost} (bot-detection publisher)`);
        return [];
      }
    }
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

      // Collect all unique URLs from the Unpaywall response — both direct PDF
      // URLs (url_for_pdf) and OA HTML landing pages (url when url_for_pdf is
      // absent).  HtmlLandingPDFResolver / PublisherPatternResolver handles the
      // latter via citation_pdf_url or anchor heuristics.
      const seen      = new Set();
      const candidates = [];
      let priority = 100;

      // Helper: push a candidate if not already seen.
      const _push = (url, kind) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        candidates.push({
          sourceId: "unpaywall",
          label: "Unpaywall",
          url,
          kind,
          priority: priority--,
          headers: { Referer: "https://unpaywall.org/" }
        });
      };

      const allLocations = [
        data?.best_oa_location,
        ...(Array.isArray(data?.oa_locations) ? data.oa_locations : [])
      ].filter(Boolean);

      for (const loc of allLocations) {
        if (loc.url_for_pdf) {
          _push(loc.url_for_pdf, _looksLikePdf(loc.url_for_pdf) ? "direct-pdf" : "landing-page");
        } else if (loc.url && loc.is_oa) {
          // No direct PDF URL but OA HTML landing page — add as landing-page.
          _push(loc.url, "landing-page");
        }
      }

      // Sort: safe OA hosts (arxiv, PMC, …) first; they succeed without auth.
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
      const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(ids.doi)}?fields=openAccessPdf,externalIds`;
      const resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: 10000,
        headers: { "User-Agent": `ZotFetch/${ZotFetchPlugin?.version || "1.4"} (mailto:zotfetch@gmail.com)` }
      });

      const pdfUrl   = resp.response?.openAccessPdf?.url;
      const s2ArXiv  = resp.response?.externalIds?.ArXiv;

      if (pdfUrl) {
        ZotFetch.cooldown.markDomainSuccess(domain);
        return [{
          sourceId: "semanticscholar",
          label: "Semantic Scholar",
          url: pdfUrl,
          kind: _looksLikePdf(pdfUrl) ? "direct-pdf" : "landing-page",
          priority: 95
        }];
      }

      // Fallback: when S2 knows the arXiv ID (even if the Zotero item doesn't
      // have it stored), build a direct arXiv PDF candidate.  S2 indexes many
      // preprints whose arXiv ID never makes it into the Zotero archiveID field
      // (e.g., items imported via CrossRef or PubMed metadata).
      if (s2ArXiv && !ids.arxivId) {
        ZotFetch.cooldown.markDomainSuccess(domain);
        return [{
          sourceId: "semanticscholar",
          label: "Semantic Scholar (arXiv)",
          url: `https://arxiv.org/pdf/${s2ArXiv}`,
          kind: "direct-pdf",
          priority: 94
        }];
      }

      ZotFetch.cooldown.markDomainNonCaptcha(domain);
      return [];
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
      const url = `https://api.openalex.org/works/https://doi.org/${encodeURI(ids.doi)}?select=open_access,best_oa_location&mailto=${encodeURIComponent(email)}`;
      const resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: 10000
      });

      const data        = resp.response;
      const pdfUrl      = data?.best_oa_location?.pdf_url || null;
      const landingUrl  = !pdfUrl ? (data?.best_oa_location?.landing_page_url || null) : null;

      if (!pdfUrl && !landingUrl) {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
        return [];
      }

      ZotFetch.cooldown.markDomainSuccess(domain);

      if (pdfUrl) {
        return [{
          sourceId: "openalex",
          label: "OpenAlex",
          url: pdfUrl,
          kind: _looksLikePdf(pdfUrl) ? "direct-pdf" : "landing-page",
          priority: 90
        }];
      }

      // No direct PDF URL from OpenAlex — use the OA landing page.  The HTML
      // resolver chain (HtmlLandingPDFResolver / PublisherPatternResolver) will
      // extract citation_pdf_url or equivalent from the rendered page.
      return [{
        sourceId: "openalex",
        label: "OpenAlex",
        url: landingUrl,
        kind: "landing-page",
        priority: 89
      }];
    } catch (error) {
      ZotFetch.cooldown.markDomainNonCaptcha(domain);
      Zotero.logError(error);
      return [];
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CoreSourceResolver
// Queries the CORE API (core.ac.uk) which indexes 234M+ research outputs from
// institutional repositories, preprint servers, and OA journals.
// Works without an API key (10 req/min) or with a free key (10k/day).
// Register at https://core.ac.uk/services/api
// ─────────────────────────────────────────────────────────────────────────────
var CoreSourceResolver = class {
  constructor() { this.id = "core"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];

    const domain = "api.core.ac.uk";
    if (ZotFetch.cooldown.isDomainCoolingDown(domain)) return [];
    await ZotFetch.cooldown.honorDomainGap(domain, ZotFetchPrefs);

    try {
      const apiKey = ZotFetchPrefs.getCoreApiKey();
      const headers = apiKey
        ? { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
        : { Accept: "application/json" };

      // Use the search endpoint with DOI query; limit=3 to get deduped repo copies.
      const q = encodeURIComponent(`doi:"${ids.doi}"`);
      const url = `https://api.core.ac.uk/v3/search/works?q=${q}&fields=downloadUrl,fullTextLink,links&limit=3`;

      const resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: 12000,
        headers
      });

      const results = resp.response?.results;
      if (!Array.isArray(results) || !results.length) {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
        return [];
      }

      const candidates = [];
      const seen = new Set();

      for (const work of results) {
        // downloadUrl is the most reliable — direct PDF from institutional repo.
        if (work.downloadUrl && !seen.has(work.downloadUrl)) {
          seen.add(work.downloadUrl);
          candidates.push({
            sourceId: "core",
            label: "CORE",
            url: work.downloadUrl,
            kind: _looksLikePdf(work.downloadUrl) ? "direct-pdf" : "landing-page",
            priority: 88
          });
        }
        // links[] may contain additional download URLs (e.g. from mirror repos).
        if (Array.isArray(work.links)) {
          for (const link of work.links) {
            if (!link.url || seen.has(link.url)) continue;
            seen.add(link.url);
            candidates.push({
              sourceId: "core",
              label: "CORE",
              url: link.url,
              kind: link.type === "download" || _looksLikePdf(link.url) ? "direct-pdf" : "landing-page",
              priority: 87
            });
          }
        }
        // fullTextLink as last resort (may be HTML reader).
        if (work.fullTextLink && !seen.has(work.fullTextLink)) {
          seen.add(work.fullTextLink);
          candidates.push({
            sourceId: "core",
            label: "CORE",
            url: work.fullTextLink,
            kind: _looksLikePdf(work.fullTextLink) ? "direct-pdf" : "landing-page",
            priority: 86
          });
        }
      }

      if (!candidates.length) {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
        return [];
      }

      ZotFetch.cooldown.markDomainSuccess(domain);
      return candidates;

    } catch (error) {
      if (Utils.isCaptchaError(error)) {
        ZotFetch.cooldown.markDomainCaptcha(domain);
      } else {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
      }
      Zotero.logError(error);
      return [];
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// EuropePmcSourceResolver
// Queries the Europe PMC REST API which provides open-access full-text links
// for biomedical literature. Uses PMID (preferred) or DOI.
// No API key required. Polite-use rate limit: 10 req/sec.
// ─────────────────────────────────────────────────────────────────────────────
var EuropePmcSourceResolver = class {
  constructor() { this.id = "europepmc"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    // Fast path: when the PubMed Central ID is already known the paper is
    // guaranteed to be in PMC and therefore open access.  Skip the API search
    // and build a direct landing-page candidate — Europe PMC exposes
    // citation_pdf_url for every PMC article, so HtmlLandingPDFResolver
    // resolves it in a single request without a prior API call.
    if (ids.pmcid) {
      return [{
        sourceId: "europepmc",
        label: "Europe PMC",
        url: `https://europepmc.org/articles/${ids.pmcid}`,
        kind: "landing-page",
        priority: 89
      }];
    }

    // Needs at least a PMID or DOI.
    if (!ids.pmid && !ids.doi) return [];

    const domain = "www.ebi.ac.uk";
    if (ZotFetch.cooldown.isDomainCoolingDown(domain)) return [];
    await ZotFetch.cooldown.honorDomainGap(domain, ZotFetchPrefs);

    try {
      // PMID lookup is more precise for biomedical papers; DOI as fallback.
      const query = ids.pmid
        ? `EXT_ID:${ids.pmid} AND SRC:MED`
        : `DOI:"${ids.doi}"`;
      const email = ZotFetchPrefs.getUnpaywallEmail();
      const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&format=json&resultType=core&pageSize=1&email=${encodeURIComponent(email)}`;

      const resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: 10000,
        headers: { Accept: "application/json" }
      });

      const articles = resp.response?.resultList?.result;
      if (!Array.isArray(articles) || !articles.length) {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
        return [];
      }

      const article = articles[0];
      // Only continue if article is open access.
      if (article.isOpenAccess !== "Y") {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
        return [];
      }

      const fullTextUrls = article.fullTextUrlList?.fullTextUrl || [];
      const candidates = [];

      for (const entry of fullTextUrls) {
        const { url: ftUrl, availabilityCode, documentStyle } = entry;
        if (!ftUrl) continue;
        // availabilityCode: OA = open access, F = free (same), S = subscription.
        const isOpenAccess = availabilityCode === "OA" || availabilityCode === "F";
        if (!isOpenAccess) continue;

        const isPdf = documentStyle === "pdf" || _looksLikePdf(ftUrl);
        candidates.push({
          sourceId: "europepmc",
          label: "Europe PMC",
          url: ftUrl,
          kind: isPdf ? "direct-pdf" : "landing-page",
          // PDF URLs get higher priority than HTML reader pages.
          priority: isPdf ? 89 : 87
        });
      }

      if (!candidates.length) {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
        return [];
      }

      ZotFetch.cooldown.markDomainSuccess(domain);
      return candidates;

    } catch (error) {
      if (Utils.isCaptchaError(error)) {
        ZotFetch.cooldown.markDomainCaptcha(domain);
      } else {
        ZotFetch.cooldown.markDomainNonCaptcha(domain);
      }
      Zotero.logError(error);
      return [];
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// OaRepositorySourceResolver
// Uses the raw item URL when it points to a known safe OA host (e.g. arXiv,
// PubMed Central, Zenodo). Reads ids.itemUrl — the unmodified Zotero URL field
// — rather than ids.url (which may have been replaced by a doi.org URL).
// ─────────────────────────────────────────────────────────────────────────────
var OaRepositorySourceResolver = class {
  constructor() { this.id = "oa-repository"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    const candidates = [];

    // When a direct arXiv ID is known, produce a direct-pdf candidate at a
    // slightly higher priority than the generic OA landing-page.  This is
    // faster (one fewer HTTP round-trip) and more reliable: the arxiv.org PDF
    // endpoint serves the file directly without any JS rendering or meta-tag
    // parsing.  Works for both published papers with an arXiv preprint and
    // pure preprints that have no DOI yet.
    if (ids.arxivId) {
      candidates.push({
        sourceId: "oa-repository",
        label: "arXiv",
        url: `https://arxiv.org/pdf/${ids.arxivId}`,
        kind: "direct-pdf",
        priority: 86
      });
    }

    // Use the raw item URL, not the DOI-derived canonical URL.
    const url = ids.itemUrl;
    if (url && /^https?:\/\//i.test(url)) {
      const domain = Utils.getDomain(url);
      if (domain) {
        // Belt-and-suspenders: never follow aggregator URLs even if somehow
        // ids.itemUrl escaped the aggregator filter in identifiers.mjs.
        if (IdentifierExtractor._isAggregatorHost(domain)) {
          Zotero.debug(`[OaRepositorySourceResolver] Skipping aggregator URL: ${domain}`);
        } else if (ZotFetch.isSafeOAHost(domain)) {
          // Skip duplicate arxiv.org URL when a direct-pdf candidate was already
          // added above — the landing-page is slower and provides no extra value.
          const isArxivUrl = domain === "arxiv.org" || domain.endsWith(".arxiv.org");
          if (!isArxivUrl || !ids.arxivId) {
            candidates.push({
              sourceId: "oa-repository",
              label: "OA Repository",
              url,
              kind: _looksLikePdf(url) ? "direct-pdf" : "landing-page",
              priority: 85
            });
          }
        }
      }
    }

    return candidates;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// NativeDoiSourceResolver
// Delegates DOI-based PDF resolution to Zotero's built-in machinery.
// Zotero uses its translator library — the same engine the Zotero Connector
// uses when you click it on a publisher page — together with any proxy rules
// configured in Tools → Preferences → Proxies.
//
// When the user is on an institutional IP/VPN, all HTTP requests from Zotero
// originate from that authenticated network, so publisher servers serve PDFs
// directly, exactly like the Connector does from a browser on the same network.
//
// Placed above our custom DoiLandingSourceResolver (priority 80): Zotero's
// translator library covers more publishers than our hand-written HTML
// heuristics.  If Zotero 8 does not recognise the "doi" method the call
// returns false silently and the pipeline continues to DoiLanding.
// ─────────────────────────────────────────────────────────────────────────────
var NativeDoiSourceResolver = class {
  constructor() { this.id = "native-doi"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];
    return [{
      sourceId: "native-doi",
      label: "Zotero Native (DOI)",
      url: "",          // empty URL — handled as a sentinel in processItem
      kind: "api-result",
      priority: 83     // below OA repo (85); above custom DOI landing (80)
    }];
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DoiLandingSourceResolver
// Follows the canonical DOI resolver, which redirects to the publisher page.
// We mark it as a landing-page so HtmlLandingPDFResolver will extract the PDF.
// Fallback for publishers not covered by Zotero's native translator library.
// ─────────────────────────────────────────────────────────────────────────────
var DoiLandingSourceResolver = class {
  constructor() { this.id = "doi-landing"; }

  enabled() { return true; }

  async buildCandidates(_item, ids) {
    if (!ids.doi) return [];

    // Tag the candidate with the known publisher host (derived from DOI prefix)
    // so fetch.mjs can apply the protected-host policy and attempt limiter
    // before following the doi.org redirect.
    const publisherHost = _publisherHostFromDoi(ids.doi);

    return [{
      sourceId: "doi-landing",
      label: "DOI Landing",
      url: `https://doi.org/${encodeURI(ids.doi)}`,
      kind: "landing-page",
      priority: 80,
      headers: { Referer: "https://doi.org/" },
      meta: publisherHost ? { publisherHost } : undefined
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

    const doiTarget = `https://doi.org/${encodeURI(ids.doi)}`;
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
    const s2ApiDomain = "api.semanticscholar.org";
    if (!ZotFetch.cooldown.isDomainCoolingDown(s2ApiDomain)) {
      await ZotFetch.cooldown.honorDomainGap(s2ApiDomain, ZotFetchPrefs);
      try {
        const email = ZotFetchPrefs.getUnpaywallEmail();
        const s2url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(ids.doi)}?fields=openAccessPdf`;
        const resp = await Zotero.HTTP.request("GET", s2url, {
          responseType: "json",
          timeout: 8000,
          headers: { "User-Agent": `ZotFetch/${ZotFetchPlugin?.version || "1.4"} (mailto:${email})` }
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
    const doiTarget = `https://doi.org/${encodeURI(ids.doi)}`;
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

// Expose the DOI-prefix → publisher-host helper so fetch.mjs can apply the
// same protected-host checks inside the native/native-doi sentinel handlers.
this.ZotFetchPublisherHostFromDoi = _publisherHostFromDoi;
this.NativeSourceResolver = NativeSourceResolver;
this.UnpaywallSourceResolver = UnpaywallSourceResolver;
this.SemanticScholarSourceResolver = SemanticScholarSourceResolver;
this.OpenAlexSourceResolver = OpenAlexSourceResolver;
this.CoreSourceResolver = CoreSourceResolver;
this.EuropePmcSourceResolver = EuropePmcSourceResolver;
this.OaRepositorySourceResolver = OaRepositorySourceResolver;
this.NativeDoiSourceResolver = NativeDoiSourceResolver;
this.DoiLandingSourceResolver = DoiLandingSourceResolver;
this.InstitutionalProxySourceResolver = InstitutionalProxySourceResolver;
this.CapesSourceResolver = CapesSourceResolver;
