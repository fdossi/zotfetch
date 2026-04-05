// chrome/content/fetch.mjs
// PDF fetching pipeline — orchestrates SourceResolvers → PDFResolvers → AttachmentImporter.
//
// Architecture overview
// ─────────────────────
//  processItem()
//    └─ IdentifierExtractor.fromItem()       — DOI, arXiv, URL, metadata
//    └─ SourceResolver[].buildCandidates()   — produce SourceCandidates per route
//    └─ sort by priority
//    └─ for each candidate:
//         PDFResolver[].resolve()            — HEAD/GET → real PDF URL
//           ├─ DirectPDFResolver             — kind=direct-pdf
//           ├─ PublisherPatternResolver      — landing-page, known hosts
//           ├─ HtmlLandingPDFResolver        — landing-page, generic extraction
//           └─ ScihubPDFResolver             — landing-page, Sci-Hub embed
//         AttachmentImporter.importResolvedPdf()
//
// Adding a new source: implement SourceResolver and add it to _buildSourceResolvers().
// Adding a new PDF extractor: implement PDFResolver and add it to _buildPdfResolvers().

const NATIVE_METHODS = ["oa"];
const SAFE_OA_HOSTS = new Set([
  "arxiv.org", "ar5iv.labs.arxiv.org",
  "europepmc.org", "ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov",
  "biorxiv.org", "medrxiv.org", "chemrxiv.org",
  "hal.science", "hal.archives-ouvertes.fr",
  "zenodo.org", "figshare.com",
  "core.ac.uk", "doaj.org", "oapen.org",
  "psyarxiv.com", "osf.io", "ssrn.com",
  "mdpi.com",
  "semanticscholar.org", "pdfs.semanticscholar.org",
  "openalex.org"
]);

class ZotFetch {
  static cooldown = new CooldownManager();
  static failedItems = new Map(); // Map<itemId, {item, reason, doi}>
  static _lastFetchReason = "nopdf"; // most severe failure reason for current item

  static async runUltraFastBatch() {
    return this.runBatch({ ultraFast: true });
  }

  static async runBatch(options = {}) {
    const ultraFast = !!options.ultraFast;
    const forcedItems = options.items || null;
    const forceMode = options.forceMode || null;
    const isRetry = !!options.isRetry;
    const pane = Zotero.getActiveZoteroPane?.();
    const items = forcedItems || pane?.getSelectedItems?.() || [];

    if (!items.length) {
      Zotero.alert(null, "ZotFetch", isRetry ? "Nenhum item para retry." : "Selecione itens para download.");
      return;
    }

    const candidates = [];
    for (const item of items) {
      if (!item?.isRegularItem?.()) {
        continue;
      }
      if (await this.hasPDF(item)) {
        continue;
      }
      candidates.push(item);
    }

    if (!candidates.length) {
      Zotero.alert(null, "ZotFetch", "Nenhum item elegível encontrado (sem PDF anexado).");
      return;
    }

    const batchSize = ZotFetchPrefs.getBatchSize();
    const batch = isRetry ? candidates : candidates.slice(0, batchSize);
    const fastMode = !forceMode && (ultraFast || ZotFetchPrefs.isFastModeEnabled());
    const runFallbackPass = !forceMode && fastMode && !ultraFast;
    const requestDelayMs = ultraFast
      ? Math.min(450, ZotFetchPrefs.getRequestDelayMs())
      : ZotFetchPrefs.getRequestDelayMs();
    const stats = {
      downloaded: 0,
      native: 0,
      unpaywall: 0,
      semanticscholar: 0,
      openalex: 0,
      institutional: 0,
      scihub: 0,
      capes: 0,
      deferred: 0,
      notFound: 0,
      failed: 0,
      captcha: 0,
      doiRecovered: 0
    };

    const libraryID = batch[0]?.libraryID;
    const libraryName = libraryID != null && Zotero.Libraries?.getName
      ? Zotero.Libraries.getName(libraryID)
      : "Biblioteca ativa";

    const progressWindow = new Zotero.ProgressWindow({ closeOnClick: true });
    const headlineLabel = isRetry ? 'ZotFetch Retry' : (ultraFast ? 'ZotFetch Ultra Fast' : 'ZotFetch Batch');
    progressWindow.changeHeadline(`${headlineLabel} (${libraryName})`);
    progressWindow.show();
    const icon = "chrome://zotero/skin/treeitem-attachment-pdf.png";
    const progress = new progressWindow.ItemProgress(icon, `Processando ${batch.length} item(ns)...`);
    progress.setProgress(5);

    const unresolved = [];
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const title = this.getItemLabel(item);
      progress.setText(`${this.getProgressStatus(stats, batch.length, i + 1, false)} ${fastMode ? (runFallbackPass ? 'Passo 1/2' : 'Passo 1/1') : 'Passo 1/1'} [${i + 1}/${batch.length}] ${title} | PDFs ${stats.downloaded}/${batch.length} (${Math.round((stats.downloaded / batch.length) * 100)}%)`);
      progress.setProgress(Math.max(5, Math.round(((i + 1) / batch.length) * 95)));

      try {
        const mode = forceMode || (ultraFast ? "ultra" : (fastMode ? "fast" : "full"));
        const result = await this.processItem(item, stats, mode);
        if (result === "captcha") {
          stats.captcha++;
        }
        if (result === "deferred") {
          unresolved.push(item);
          stats.deferred++;
        }
      } catch (error) {
        stats.failed++;
        Zotero.logError(error);
      }

      if (i < batch.length - 1) {
        await this.cooldown.sleepWithJitter(requestDelayMs);
      }

      progress.setText(`${this.getProgressStatus(stats, batch.length, i + 1, false)} ${fastMode ? (runFallbackPass ? 'Passo 1/2' : 'Passo 1/1') : 'Passo 1/1'} [${i + 1}/${batch.length}] ${title} | PDFs ${stats.downloaded}/${batch.length} (${Math.round((stats.downloaded / batch.length) * 100)}%)`);
    }

    if (runFallbackPass && unresolved.length) {
      for (let i = 0; i < unresolved.length; i++) {
        const item = unresolved[i];
        const title = this.getItemLabel(item);
        progress.setText(`${this.getProgressStatus(stats, batch.length, batch.length, false)} Passo 2/2 [${i + 1}/${unresolved.length}] ${title} | PDFs ${stats.downloaded}/${batch.length} (${Math.round((stats.downloaded / batch.length) * 100)}%)`);
        progress.setProgress(Math.max(60, Math.round(60 + ((i + 1) / unresolved.length) * 35)));

        try {
          const result = await this.processItem(item, stats, "fallback");
          if (result === "captcha") {
            stats.captcha++;
          }
        } catch (error) {
          stats.failed++;
          Zotero.logError(error);
        }

        if (i < unresolved.length - 1) {
          await this.cooldown.sleepWithJitter(requestDelayMs);
        }

        progress.setText(`${this.getProgressStatus(stats, batch.length, batch.length, false)} Passo 2/2 [${i + 1}/${unresolved.length}] ${title} | PDFs ${stats.downloaded}/${batch.length} (${Math.round((stats.downloaded / batch.length) * 100)}%)`);
      }
    }

    if (ultraFast && unresolved.length) {
      stats.notFound += unresolved.length;
      for (const item of unresolved) {
        if (!ZotFetch.failedItems.has(String(item.id))) {
          const doi = Utils.normalizeDOI(item.getField("DOI")) || "";
          ZotFetch.failedItems.set(String(item.id), { item, reason: "nopdf", doi });
        }
      }
    }

    progress.setText(
      `${this.getProgressStatus(stats, batch.length, batch.length, true)} Concluído: ${stats.downloaded} baixados (nativo ${stats.native}, Unpaywall ${stats.unpaywall}, S2 ${stats.semanticscholar}, OA ${stats.openalex}, Institucional ${stats.institutional}, Sci-Hub ${stats.scihub}, CAPES ${stats.capes}) | pendentes ${stats.deferred} | DOI recuperado ${stats.doiRecovered} | não encontrado ${stats.notFound} | erros ${stats.failed} | captcha ${stats.captcha}`
    );
    progress.setProgress(100);
    progressWindow.startCloseTimer(10000);
  }

  // ── Main item processor ─────────────────────────────────────────────────

  /**
   * Attempt to find and attach a PDF for one Zotero item.
   *
   * Modes:
   *   "fast"     — native + unpaywall + s2 + openalex + oa-repo + doi-landing + proxy;
   *                no Sci-Hub; defers to fallback pass on failure.
   *   "ultra"    — fast sources + limited Sci-Hub mirrors; no fallback pass.
   *   "fallback" — Sci-Hub (full mirror list) + CAPES.
   *   "full"     — all sources, no deferral.
   */
  static async processItem(item, stats, mode = "full") {
    ZotFetch.failedItems.delete(String(item.id));
    if (await this.hasPDF(item)) return "already";
    ZotFetch._lastFetchReason = "nopdf";

    // 1. Extract identifiers (DOI, arXiv, URL, metadata).
    const ids = await IdentifierExtractor.fromItem(item);

    // Attempt CrossRef DOI lookup if not found yet (skipped in ultra mode).
    if (!ids.doi && mode !== "ultra") {
      const lookedUp = await this.lookupDOI(item);
      if (lookedUp) {
        ids.doi = lookedUp;
        stats.doiRecovered++;
      }
    }

    // 2. Build source candidates from mode-appropriate resolvers.
    const sourceResolvers = this._buildSourceResolvers(mode);
    const pdfResolvers    = this._buildPdfResolvers();

    const allCandidates = [];
    for (const sr of sourceResolvers) {
      if (!sr.enabled()) continue;
      try {
        const partial = await sr.buildCandidates(item, ids);
        allCandidates.push(...partial);
      } catch (err) {
        Zotero.logError(err);
      }
    }

    // Sort descending by priority.
    allCandidates.sort((a, b) => b.priority - a.priority);

    Zotero.debug(`[ZotFetch] ${this.getItemLabel(item)}: ${allCandidates.length} candidate(s) [mode=${mode}]`);

    // 3. Try each candidate through the PDF resolver chain.
    for (const candidate of allCandidates) {
      // Native sentinel — delegate to Zotero's OA finder directly.
      if (candidate.sourceId === "native") {
        if (await this.tryNative(item)) {
          stats.downloaded++;
          stats.native++;
          Zotero.debug(`[ZotFetch] ✓ native (item ${item.id})`);
          return "native";
        }
        continue;
      }

      const result = await this._resolveCandidate(candidate, pdfResolvers);
      if (!result.ok) {
        const reason = result.failureReason || "nopdf";
        const PRIORITY = { cloudflare: 6, captcha: 5, auth: 4, blocked: 3, timeout: 2, network: 1, nopdf: 0 };
        if ((PRIORITY[reason] || 0) > (PRIORITY[ZotFetch._lastFetchReason] || 0)) {
          ZotFetch._lastFetchReason = reason;
        }
        Zotero.debug(`[ZotFetch] ✗ ${candidate.sourceId} → ${reason}`);
        continue;
      }

      // 4. Import the resolved PDF.
      const t0 = Date.now();
      const ok = await AttachmentImporter.importResolvedPdf(item, result, candidate.label);
      if (ok) {
        stats.downloaded++;
        const sid = candidate.sourceId;
        Zotero.debug(`[ZotFetch] ✓ ${sid} (${Date.now() - t0}ms, item ${item.id})`);
        if (sid === "unpaywall")             stats.unpaywall++;
        else if (sid === "semanticscholar")  stats.semanticscholar++;
        else if (sid === "openalex")         stats.openalex++;
        else if (sid.startsWith("institutional-proxy")) stats.institutional++;
        else if (sid === "capes")            stats.capes++;
        else if (sid === "scihub")           stats.scihub++;
        else                                 stats.unpaywall++; // oa-repo / doi-landing → unpaywall bucket
        return sid;
      }
    }

    // 5. Nothing worked.
    if (mode === "fast") return "deferred";

    ZotFetch.failedItems.set(String(item.id), {
      item,
      reason: ZotFetch._lastFetchReason,
      doi: ids.doi || ""
    });
    stats.notFound++;
    return "notfound";
  }

  // ── Pipeline builder helpers ─────────────────────────────────────────────

  /**
   * Return the ordered list of SourceResolvers for a given mode.
   */
  static _buildSourceResolvers(mode) {
    const fast = [
      new NativeSourceResolver(),
      new UnpaywallSourceResolver(),
      new SemanticScholarSourceResolver(),
      new OpenAlexSourceResolver(),
      new OaRepositorySourceResolver(),
      new DoiLandingSourceResolver(),
      new InstitutionalProxySourceResolver()
    ];
    if (mode === "fast")     return fast;
    if (mode === "ultra")    return [...fast, new ScihubSourceResolver()];
    if (mode === "fallback") return [new ScihubSourceResolver(), new CapesSourceResolver()];
    // "full" — all sources
    return [...fast, new ScihubSourceResolver(), new CapesSourceResolver()];
  }

  /** Return the ordered list of PDFResolvers. */
  static _buildPdfResolvers() {
    return [
      new DirectPDFResolver(),
      new ScihubPDFResolver(),
      new PublisherPatternResolver(),
      new HtmlLandingPDFResolver()
    ];
  }

  /**
   * Run a SourceCandidate through matching PDFResolvers until one succeeds.
   */
  static async _resolveCandidate(candidate, resolvers) {
    const ctx = {
      timeoutMs: ZotFetchPrefs.getRequestTimeoutMs(),
      cooldown: this.cooldown,
      prefs: ZotFetchPrefs,
      userAgents: [Utils.getStealthHeaders()["User-Agent"]],
      logger: (msg) => Zotero.debug(msg)
    };
    for (const resolver of resolvers) {
      if (!resolver.canResolve(candidate)) continue;
      try {
        const result = await resolver.resolve(candidate, ctx);
        if (result.ok) return result;
      } catch (err) {
        Zotero.logError(err);
      }
    }
    return { ok: false, failureReason: "nopdf" };
  }

  // ── Native Zotero OA resolver ────────────────────────────────────────────

  static async tryNative(item) {
    if (!Zotero.Attachments.canFindFileForItem(item)) return false;
    await Zotero.Attachments.addAvailableFile(item, { methods: NATIVE_METHODS });
    return this.hasPDF(item);
  }

  // ── Legacy try* helpers (kept for backward compatibility) ────────────────
  // These now delegate to the new pipeline via buildCandidates + resolveCandidate.

  static async tryUnpaywall(item, doi) {
    const ids = doi ? { doi } : await IdentifierExtractor.fromItem(item);
    return this._trySourceResolver(item, new UnpaywallSourceResolver(), ids);
  }

  static async trySemanticScholar(item, doi) {
    const ids = doi ? { doi } : await IdentifierExtractor.fromItem(item);
    return this._trySourceResolver(item, new SemanticScholarSourceResolver(), ids);
  }

  static async tryOpenAlex(item, doi) {
    const ids = doi ? { doi } : await IdentifierExtractor.fromItem(item);
    return this._trySourceResolver(item, new OpenAlexSourceResolver(), ids);
  }

  static async tryInstitutionalProxy(item, doi) {
    const ids = doi ? { doi } : await IdentifierExtractor.fromItem(item);
    return this._trySourceResolver(item, new InstitutionalProxySourceResolver(), ids);
  }

  static async tryCapes(item, doi) {
    const ids = doi ? { doi } : await IdentifierExtractor.fromItem(item);
    return this._trySourceResolver(item, new CapesSourceResolver(), ids);
  }

  static async tryScihub(item, doi, maxMirrors = null) {
    const ids = doi ? { doi } : await IdentifierExtractor.fromItem(item);
    const resolver = new ScihubSourceResolver();
    if (!resolver.enabled()) return false;

    let candidates;
    try { candidates = await resolver.buildCandidates(item, ids); } catch (err) { Zotero.logError(err); return false; }

    const selected = Number.isFinite(maxMirrors) && maxMirrors > 0
      ? candidates.slice(0, maxMirrors)
      : candidates;

    const pdfResolvers = this._buildPdfResolvers();
    for (const candidate of selected) {
      const result = await this._resolveCandidate(candidate, pdfResolvers);
      if (!result.ok) continue;
      const ok = await AttachmentImporter.importResolvedPdf(item, result, candidate.label);
      if (ok) return true;
    }
    return false;
  }

  /** Try all candidates from one SourceResolver and import the first success. */
  static async _trySourceResolver(item, sourceResolver, ids) {
    if (!sourceResolver.enabled()) return false;
    let candidates;
    try { candidates = await sourceResolver.buildCandidates(item, ids); } catch (err) { Zotero.logError(err); return false; }

    const pdfResolvers = this._buildPdfResolvers();
    for (const candidate of candidates) {
      const result = await this._resolveCandidate(candidate, pdfResolvers);
      if (!result.ok) continue;
      const ok = await AttachmentImporter.importResolvedPdf(item, result, candidate.label);
      if (ok) return true;
    }
    return false;
  }

  // ── Sci-Hub utilities (used by ScihubPDFResolver) ───────────────────────

  static isCloudflareChallengePage(html) {
    const lower = html.toLowerCase();
    return lower.includes("cf-challenge") ||
           lower.includes("cf_chl") ||
           lower.includes("turnstile") ||
           lower.includes("jschl_vc") ||
           lower.includes("checking if the site connection is secure") ||
           lower.includes("enable javascript and cookies to continue");
  }

  // Parses a Sci-Hub HTML landing page and extracts the direct hosted PDF URL.
  // Sci-Hub embeds the PDF in an <embed>, <iframe id="pdf">, or JS redirect.
  static extractScihubPdfUrl(html, mirrorOrigin) {
    if (!html) return null;

    // Pattern 1: <embed src="//dacemirror.sci-hub.se/.../file.pdf#...">
    const embedMatch = html.match(/<embed[^>]+src=["']([^"']+)["']/i);
    if (embedMatch) {
      const src = embedMatch[1].split("#")[0].trim();
      if (src && (src.toLowerCase().includes(".pdf") || src.includes("/pdf"))) {
        return this.resolveRelativeUrl(src, mirrorOrigin);
      }
    }

    // Pattern 2: <iframe id="pdf" src="...">
    const iframeMatch =
      html.match(/<iframe[^>]+id=["']pdf["'][^>]*src=["']([^"']+)["']/i) ||
      html.match(/<iframe[^>]+src=["']([^"']+)["'][^>]*id=["']pdf["']/i);
    if (iframeMatch) {
      const src = iframeMatch[1].split("#")[0].trim();
      if (src && !src.toLowerCase().includes("captcha") && !src.includes("challenge")) {
        return this.resolveRelativeUrl(src, mirrorOrigin);
      }
    }

    // Pattern 3: JS redirect — onclick / location.href
    const onclickMatch = html.match(/onclick\s*=\s*["'][^"']*location\.href\s*=\s*'([^']+)'[^"']*["']/i);
    if (onclickMatch) {
      const src = onclickMatch[1].split("?")[0].trim();
      if (src.toLowerCase().includes(".pdf")) {
        return this.resolveRelativeUrl(src, mirrorOrigin);
      }
    }

    return null;
  }

  // Resolves protocol-relative and root-relative URLs to absolute HTTPS.
  static resolveRelativeUrl(url, origin) {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("/")) return origin + url;
    return null;
  }

  // ── Legacy fetchPDF (kept for any edge callers) ───────────────────────────
  // Wraps the candidate system; treat the URL as a direct-pdf or landing-page
  // candidate, resolve it, then import.

  static async fetchPDF(item, url, source) {
    if (!url || !/^https?:\/\//i.test(String(url))) return false;

    const domain = Utils.getDomain(url);
    if (ZotFetchPrefs.isAntiCaptchaMode() && this.cooldown.isDomainCoolingDown(domain)) return false;

    if (source.includes("Institutional") || source.includes("CAPES") || source.includes("Sci-Hub")) {
      await this.cooldown.applyProtectedDelay();
    }
    await this.cooldown.honorDomainGap(domain, ZotFetchPrefs);

    const isLikelyPdf = /\.pdf(\?|#|$)/i.test(url);
    const candidate = {
      sourceId: source.toLowerCase().replace(/\s+/g, "-"),
      label: source,
      url,
      kind: isLikelyPdf ? "direct-pdf" : "landing-page",
      priority: 50,
      headers: {
        ...Utils.getStealthHeaders(),
        Accept: isLikelyPdf ? "application/pdf,*/*;q=0.8" : "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        DNT: "1",
        Referer: source.includes("Institutional") || source.includes("CAPES")
          ? "https://scholar.google.com/"
          : source.includes("Sci-Hub") ? "https://sci-hub.se/" : "https://doi.org/"
      }
    };

    const result = await this._resolveCandidate(candidate, this._buildPdfResolvers());
    if (!result.ok) {
      const reason = result.failureReason || "nopdf";
      const PRIORITY = { cloudflare: 6, captcha: 5, auth: 4, blocked: 3, timeout: 2, network: 1, nopdf: 0 };
      if ((PRIORITY[reason] || 0) > (PRIORITY[ZotFetch._lastFetchReason] || 0)) {
        ZotFetch._lastFetchReason = reason;
      }
      return false;
    }
    return AttachmentImporter.importResolvedPdf(item, result, source);
  }

  // ── Proxy URL builder ─────────────────────────────────────────────────────

  static buildProxyTargetURL(proxyBase, targetURL) {
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
  }

  // ── DOI lookup via CrossRef ───────────────────────────────────────────────

  static async lookupDOI(item) {
    const title = String(item.getField("title") || "").trim();
    if (!title) return "";

    const creators = item.getCreators ? item.getCreators() : [];
    const firstAuthor = creators.length > 0
      ? (creators[0].lastName || creators[0].name || "").trim() : "";
    const year = String(item.getField("year") || "").trim();
    const email = ZotFetchPrefs.getUnpaywallEmail();
    if (!email) return "";

    try {
      let queryURL = `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}`;
      if (firstAuthor) queryURL += `&query.author=${encodeURIComponent(firstAuthor)}`;
      if (year) queryURL += `&filter=from-pub-date:${year},until-pub-date:${year}`;
      queryURL += `&rows=3&select=DOI,title,published&mailto=${encodeURIComponent(email)}`;

      const response = await Zotero.HTTP.request("GET", queryURL, {
        responseType: "json",
        timeout: ZotFetchPrefs.getCrossrefTimeoutMs()
      });

      const results = response.response?.message?.items;
      if (!Array.isArray(results) || !results.length) return "";

      for (const cand of results) {
        const candidateDOI = String(cand.DOI || "").trim();
        if (!candidateDOI) continue;
        const candidateYear = String(cand.published?.["date-parts"]?.[0]?.[0] || "");
        if (year && candidateYear && candidateYear !== year) continue;

        const candidateTitles = Array.isArray(cand.title) ? cand.title : [];
        let best = { match: false, score: 0 };
        for (const ct of candidateTitles) {
          const sim = Utils.isTitleSimilar(ct, title);
          if (sim.score > best.score) best = sim;
        }
        if (best.match) {
          item.setField("DOI", candidateDOI);
          await item.saveTx();
          return Utils.normalizeDOI(candidateDOI);
        }
      }
    } catch (error) {
      Zotero.logError(error);
    }
    return "";
  }

  // ── PDF / OA helpers ──────────────────────────────────────────────────────

  static async hasPDF(item) {
    const attachmentIDs = item.getAttachments ? item.getAttachments() : [];
    if (!attachmentIDs?.length) return false;
    const atts = await Zotero.Items.getAsync(attachmentIDs);
    return atts.some(att => {
      if (!att) return false;
      if (att.isPDFAttachment?.()) return true;
      return att.attachmentContentType === "application/pdf";
    });
  }

  static getUnpaywallPDFs(data) {
    const list = [
      data?.best_oa_location?.url_for_pdf,
      ...(Array.isArray(data?.oa_locations) ? data.oa_locations.map(loc => loc?.url_for_pdf) : [])
    ];
    return list.filter(Boolean);
  }

  static isSafeOAHost(domain) {
    if (!domain) return false;
    for (const host of SAFE_OA_HOSTS) {
      if (domain === host || domain.endsWith(`.${host}`)) return true;
    }
    return false;
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  static getItemLabel(item) {
    const title = String(item.getField("title") || "Sem título").trim();
    const year = String(item.getField("year") || "").trim();
    return year ? `${title} (${year})` : title;
  }

  static getProgressStatus(stats, total, processed = 0, isFinal = false) {
    const t = Math.max(1, parseInt(total, 10) || 1);
    const p = Math.max(0, parseInt(processed, 10) || 0);

    if (!isFinal && p < 3) return "🔵";

    if (isFinal) {
      const finalRate = stats.downloaded / t;
      const highFailure = stats.failed >= Math.max(2, Math.ceil(t * 0.25));
      if (highFailure || stats.captcha >= 4 || finalRate < 0.45) return "🔴";
      if (stats.failed > 0 || stats.captcha > 0 || finalRate < 0.8) return "🟡";
      return "🟢";
    }

    const effectiveProcessed = Math.max(1, p);
    const runningRate = stats.downloaded / effectiveProcessed;
    const runningFailureRate = stats.failed / effectiveProcessed;

    if (effectiveProcessed >= 5 && (runningFailureRate >= 0.35 || stats.captcha >= 3 || runningRate < 0.3)) return "🔴";
    if (effectiveProcessed >= 3 && (stats.failed > 0 || stats.captcha > 0 || runningRate < 0.65)) return "🟡";
    return "🟢";
  }

  static classifyError(error) {
    const msg = String(error?.message || error || "").toLowerCase();
    const status = error?.status || error?.xmlhttp?.status || 0;
    if (status === 403 && (msg.includes("cf-challenge") || msg.includes("cf_chl") ||
        msg.includes("turnstile") || msg.includes("ray id"))) return "cloudflare";
    if (Utils.isCaptchaError(error)) return "captcha";
    if (status === 401 || status === 403 || msg.includes("403") || msg.includes("forbidden") || msg.includes("unauthorized")) return "auth";
    if (status === 429 || msg.includes("429") || msg.includes("too many") || msg.includes("rate limit") || msg.includes("blocked")) return "blocked";
    if (status === 408 || status === 504 || msg.includes("timeout") || msg.includes("timed out")) return "timeout";
    if (status === 404 || msg.includes("404") || msg.includes("not found")) return "nopdf";
    return "network";
  }

  // ── Retry flows ───────────────────────────────────────────────────────────

  static async runRetryFailed() {
    if (!ZotFetch.failedItems.size) {
      Zotero.alert(null, "ZotFetch", "Nenhum item falho registrado.\nExecute o Batch Download primeiro.");
      return;
    }
    const pending = [];
    for (const info of ZotFetch.failedItems.values()) {
      if (!await this.hasPDF(info.item)) pending.push(info.item);
    }
    if (!pending.length) {
      Zotero.alert(null, "ZotFetch", "Todos os itens falhos já têm PDF.");
      ZotFetch.failedItems.clear();
      return;
    }
    ZotFetch.failedItems.clear();
    return this.runBatch({ items: pending, forceMode: "full", isRetry: true });
  }

  static async runRetryAfterAuth() {
    const authKeys = ["captcha", "auth", "blocked"];
    const authInfos = [];
    for (const info of ZotFetch.failedItems.values()) {
      if (authKeys.includes(info.reason) && !await this.hasPDF(info.item)) {
        authInfos.push(info);
      }
    }
    if (!authInfos.length) {
      Zotero.alert(null, "ZotFetch Retry After Auth",
        "Nenhum item com falha de acesso/captcha.\nExecute o Batch Download primeiro.");
      return;
    }
    const withDoi = authInfos.filter(info => info.doi);
    for (const info of withDoi.slice(0, 3)) {
      try { Zotero.launchURL(`https://doi.org/${info.doi}`); } catch (e) {}
    }
    const titles = authInfos.slice(0, 8).map((info, i) =>
      `${i + 1}. ${this.getItemLabel(info.item)} [${info.reason}]`
    ).join("\n");
    Zotero.alert(null, "ZotFetch Retry After Auth",
      `${authInfos.length} item(ns) com bloqueio de acesso:\n\n${titles}` +
      `${withDoi.length > 0 ? `\n\n${Math.min(3, withDoi.length)} URL(s) abertas no navegador.` : ""}` +
      `\n\nAutentique/resolva o captcha, depois clique OK para tentar novamente.`
    );
    for (const info of authInfos) {
      ZotFetch.failedItems.delete(String(info.item.id));
    }
    const items = authInfos.map(info => info.item);
    return this.runBatch({ items, forceMode: "full", isRetry: true });
  }
}

this.ZotFetch = ZotFetch;

