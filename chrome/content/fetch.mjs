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
//         Sentinel handlers (api-result, kind):
//           • sourceId="native"      → tryNative()     (Zotero OA finder)
//           • sourceId="native-doi" → tryNativeDoi()  (Zotero Connector-like:
//                                       translator library + Zotero proxy rules)
//         PDFResolver[].resolve()   — HEAD/GET → real PDF URL
//           ├─ DirectPDFResolver            — kind=direct-pdf
//           ├─ PublisherPatternResolver     — landing-page, known publisher hosts
//           ├─ HtmlLandingPDFResolver       — landing-page, generic meta/link/anchor
//           └─ HiddenBrowserPDFResolver     — landing-page, Gecko JS engine (Cloudflare/Akamai)
//         AttachmentImporter.importResolvedPdf()
//
// Adding a new source: implement SourceResolver and add it to _buildSourceResolvers().
// Adding a new PDF extractor: implement PDFResolver and add it to _buildPdfResolvers().

const NATIVE_METHODS     = ["oa"];   // Zotero's built-in OA resolver (Unpaywall etc.)
const NATIVE_DOI_METHODS = ["doi"];  // Zotero's translator-based DOI resolver (Connector-like)
const SAFE_OA_HOSTS = new Set([
  "arxiv.org", "ar5iv.labs.arxiv.org",
  "europepmc.org", "ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov",
  "biorxiv.org", "medrxiv.org", "chemrxiv.org",
  "hal.science", "hal.archives-ouvertes.fr",
  "zenodo.org", "figshare.com",
  "core.ac.uk", "doaj.org", "oapen.org",
  "psyarxiv.com", "osf.io", "ssrn.com",
  "mdpi.com",
  "plos.org",                          // PLOS journals (journals.plos.org etc.)
  "elifesciences.org",                 // eLife — fully OA
  "biomedcentral.com",                 // BioMed Central / Springer Nature OA
  "f1000research.com",                 // F1000Research — fully OA
  "semanticscholar.org", "pdfs.semanticscholar.org",
  "openalex.org",
  // ── New OA sources ─────────────────────────────────────────────────────────
  "scholar.archive.org",               // Internet Archive Scholar
  "web.archive.org",                   // Wayback Machine (Fatcat webarchive URLs)
  "fatcat.wiki", "api.fatcat.wiki",    // Fatcat bibliographic API
  "paperity.org",                      // Paperity OA journal aggregator
  "oa.mg"                              // OA.mg open-access aggregator
]);

class ZotFetch {
  static cooldown = new CooldownManager();
  static failedItems = new Map(); // Map<itemId, {item, reason, doi}>
  static _lastFetchReason = "nopdf"; // most severe failure reason for current item

  // Session-level negative cache: blocks re-attempting a (doi, publisher-host)
  // pair after a captcha/auth/blocked event.  Entries expire per policy TTL.
  static negativeCache = new ProtectedHosts.ProtectedHostNegativeCache();

  // Per-batch attempt counter: tracks (itemKey, publisher-host) attempts so a
  // single item cannot hammer the same protected publisher from multiple
  // equivalent candidates (Unpaywall URL, OpenAlex URL, DOI landing, …).
  // Cleared at the start of every runBatch() call.
  static _batchAttemptTracker = new ProtectedHosts.ItemHostAttemptTracker();

  // Per-batch set of publisher hosts where tryNativeDoi has already failed.
  // After one failure (off-campus, no auth) subsequent items skip native-doi
  // for that same publisher instead of each making a wasted request.
  // On VPN, tryNativeDoi succeeds immediately so this set stays empty and all
  // items benefit from institutional access.
  static _nativeDoiFailedHosts = new Set();

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

    // Reset per-batch attempt tracker so previous runs don't carry over counts.
    ZotFetch._batchAttemptTracker.clear();
    ZotFetch._nativeDoiFailedHosts.clear();
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
      core: 0,
      europepmc: 0,
      internetarchive: 0,
      paperity: 0,
      oamg: 0,
      oarepository: 0,
      institutional: 0,
      capes: 0,
      hiddenbrowser: 0,
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
      `${this.getProgressStatus(stats, batch.length, batch.length, true)} Concluído: ${stats.downloaded} baixados (nativo ${stats.native}, Unpaywall ${stats.unpaywall}, S2 ${stats.semanticscholar}, OA ${stats.openalex}, CORE ${stats.core}, EPMC ${stats.europepmc}, Institucional ${stats.institutional}, CAPES ${stats.capes}${stats.internetarchive ? `, IA ${stats.internetarchive}` : ""}${stats.paperity ? `, Paperity ${stats.paperity}` : ""}${stats.oamg ? `, OA.mg ${stats.oamg}` : ""}${stats.oarepository ? `, OARepo ${stats.oarepository}` : ""}${stats.hiddenbrowser ? `, HiddenBrowser ${stats.hiddenbrowser}` : ""}) | pendentes ${stats.deferred} | DOI recuperado ${stats.doiRecovered} | não encontrado ${stats.notFound} | erros ${stats.failed} | captcha ${stats.captcha}`
    );
    progress.setProgress(100);
    progressWindow.startCloseTimer(10000);
    this._showPaywallAdvisory();
  }

  // ── Post-batch paywalled-items advisory ─────────────────────────────────

  /**
   * After a batch run, if items failed due to subscription walls AND no
   * institutional access method is configured, show a clear alert with
   * actionable guidance.
   *
   * Skipped when a proxy or CAPES URL is already set — the user can simply
   * run Retry Failed and their credentials will handle authentication.
   */
  static _showPaywallAdvisory() {
    const authFailed = [...ZotFetch.failedItems.values()].filter(
      i => i.reason === "auth" || i.reason === "blocked"
    );
    if (!authFailed.length) return;

    const hasProxy = ZotFetchPrefs.isInstitutionalProxyEnabled();
    const hasCapes = ZotFetchPrefs.isCapesEnabled() && !!ZotFetchPrefs.getProxyUrl();
    if (hasProxy || hasCapes) return; // acesso institucional configurado → usuário já sabe retentar

    const count   = authFailed.length;
    const maxShow = 5;
    const titles  = authFailed.slice(0, maxShow)
      .map((info, n) => `  ${n + 1}. ${ZotFetch.getItemLabel(info.item)}`)
      .join("\n");
    const overflow = count > maxShow ? `\n  … e mais ${count - maxShow}` : "";

    Zotero.alert(
      null,
      `ZotFetch — ${count} ${count === 1 ? "item requer" : "itens requerem"} acesso institucional`,
      `Os itens abaixo não foram baixados por exigirem autenticação de assinatura:\n\n` +
      titles + overflow +
      `\n\nComo obter esses PDFs:\n` +
      `  • No campus ou com VPN ativa: execute ZotFetch ▶ Retry Failed —\n` +
      `    a rede autentica automaticamente.\n` +
      `  • Fora do campus: abra ZotFetch ▶ Preferências e configure\n` +
      `    o URL do Proxy Institucional (EZproxy) ou do Portal CAPES.`
    );
  }

  // ── Main item processor ─────────────────────────────────────────────────

  /**
   * Attempt to find and attach a PDF for one Zotero item.
   *
   * Modes:
   *   "fast"     — native + unpaywall + s2 + openalex + oa-repo + doi-landing + proxy;
   *                defers to fallback pass on failure.
   *   "ultra"    — fast sources; no fallback pass.
   *   "fallback" — CAPES only.
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

    // Stable key for per-item tracking (DOI preferred; fall back to item ID).
    const itemKey = ids.doi || String(item.id);

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

    // Per-item set of publisher hosts where a challenge was detected.
    // When earlyAbortOnChallenge is set for the host, all remaining
    // candidates targeting that same host are skipped immediately.
    const _localHostAborts = new Set();

    // 3. Try each candidate through the PDF resolver chain.
    for (const candidate of allCandidates) {
      // Native OA sentinel — delegate to Zotero's OA finder directly.
      if (candidate.sourceId === "native") {
        // Defence-in-depth for DOI prefixes not covered by the buildCandidates
        // filter: if a previous batch run already proved this (doi, publisher)
        // is bot-blocked, skip rather than let Zotero's real UA re-trigger it.
        if (ids.doi) {
          const _ph = ZotFetchPublisherHostFromDoi(ids.doi);
          if (_ph && ProtectedHosts.getHostPolicy(_ph)?.earlyAbortOnChallenge &&
              ZotFetch.negativeCache.has(ids.doi, _ph)) {
            Zotero.debug(`[ZotFetch] skip native (${_ph} in neg-cache)`);
            continue;
          }
        }
        if (await this.tryNative(item)) {
          stats.downloaded++;
          stats.native++;
          Zotero.debug(`[ZotFetch] ✓ native (item ${item.id})`);
          return "native";
        }
        continue;
      }

      // Native DOI sentinel — delegate to Zotero's translator-based DOI
      // resolution, mirroring what the Zotero Connector does when clicked on a
      // publisher page.  Uses Zotero's configured proxy rules so it works for
      // users on institutional IP/VPN and for users with EZproxy configured in
      // Zotero → Preferences → Proxies.
      if (candidate.sourceId === "native-doi") {
        // Guard: skip if a challenge was already detected for this item or session
        // (earlier candidate hit a captcha/auth wall for the same publisher),
        // or if native-doi already failed for this publisher in this batch run
        // (prevents N wasted requests when not on VPN/campus).
        if (ids.doi) {
          const _ph = ZotFetchPublisherHostFromDoi(ids.doi);
          if (_ph && ProtectedHosts.getHostPolicy(_ph)?.earlyAbortOnChallenge) {
            if (_localHostAborts.has(_ph) ||
                ZotFetch.negativeCache.has(ids.doi, _ph) ||
                ZotFetch._nativeDoiFailedHosts.has(_ph)) {
              Zotero.debug(`[ZotFetch] skip native-doi (${_ph} blocked/failed-batch)`);
              continue;
            }
          }
        }
        if (await this.tryNativeDoi(item)) {
          stats.downloaded++;
          stats.native++;
          Zotero.debug(`[ZotFetch] ✓ native-doi (item ${item.id})`);
          return "native-doi";
        }
        // native-doi failed: record the publisher host so remaining batch items
        // skip it (one attempt per publisher per batch, not N attempts).
        if (ids.doi) {
          const _ph = ZotFetchPublisherHostFromDoi(ids.doi);
          if (_ph) ZotFetch._nativeDoiFailedHosts.add(_ph);
        }
        continue;
      }

      // ── Effective publisher host for protected-host checks ──────────────────
      // DoiLandingSourceResolver tags doi.org candidates with meta.publisherHost
      // so we can apply protected-host policy even before the redirect happens.
      const candidateHost = Utils.getDomain(candidate.url);
      const effectiveHost = candidate.meta?.publisherHost || candidateHost;
      const hostPolicy    = ProtectedHosts.getHostPolicy(effectiveHost);

      // ── Negative cache check ────────────────────────────────────────────────
      if (ids.doi && ZotFetch.negativeCache.has(ids.doi, effectiveHost)) {
        const nc = ZotFetch.negativeCache.get(ids.doi, effectiveHost);
        Zotero.debug(
          `[ZotFetch][NegCache] SKIP ${candidate.sourceId} (${effectiveHost}) ` +
          `reason=${nc?.reason} doi=${ids.doi} item=${item.id}`
        );
        continue;
      }

      // ── Cross-item domain cooldown ──────────────────────────────────────────
      // After the first captcha/challenge from a protected publisher a penalty
      // cooldown is applied to its domain (see earlyAbortOnChallenge handler
      // below). Checking it here prevents every subsequent item in the same
      // batch from generating its own captcha against the same publisher:
      // one strike flips the switch for the rest of the batch.
      if (hostPolicy && ZotFetch.cooldown.isDomainCoolingDown(effectiveHost)) {
        Zotero.debug(
          `[ZotFetch][Cooldown] SKIP ${candidate.sourceId} (${effectiveHost}) — ` +
          `domain cooling down, doi=${ids.doi || "?"} item=${item.id}`
        );
        continue;
      }

      // ── Per-item local abort (challenge detected earlier this run) ──────────
      if (hostPolicy && _localHostAborts.has(effectiveHost)) {
        Zotero.debug(
          `[ZotFetch][ProtectedHost] SKIP ${candidate.sourceId} (${effectiveHost}) ` +
          `— host aborted for item ${item.id}`
        );
        continue;
      }

      // ── Per-batch attempt limit ─────────────────────────────────────────────
      // Prevents one item from generating many requests to the same publisher
      // when multiple source resolvers return equivalent landing-page URLs.
      if (hostPolicy) {
        const attempts = ZotFetch._batchAttemptTracker.get(itemKey, effectiveHost);
        if (attempts >= hostPolicy.maxAttemptsPerItem) {
          Zotero.debug(
            `[ZotFetch][ProtectedHost] SKIP ${candidate.sourceId} (${effectiveHost}) ` +
            `— attempt limit ${hostPolicy.maxAttemptsPerItem} reached for item ${item.id}`
          );
          continue;
        }
        const newCount = ZotFetch._batchAttemptTracker.increment(itemKey, effectiveHost);
        Zotero.debug(
          `[ZotFetch][ProtectedHost] Attempt ${newCount}/${hostPolicy.maxAttemptsPerItem}: ` +
          `${candidate.sourceId} (${effectiveHost}) doi=${ids.doi || "?"} item=${item.id}`
        );
      }

      const result = await this._resolveCandidate(candidate, pdfResolvers);
      if (!result.ok) {
        const reason = result.failureReason || "nopdf";
        const PRIORITY = { cloudflare: 6, captcha: 5, auth: 4, blocked: 3, timeout: 2, network: 1, nopdf: 0 };
        if ((PRIORITY[reason] || 0) > (PRIORITY[ZotFetch._lastFetchReason] || 0)) {
          ZotFetch._lastFetchReason = reason;
        }

        // ── Protected-host early abort on challenge or unextractable page ────────
        // Challenge events (captcha/cloudflare/blocked/auth): persistent negative
        // cache entry + longer cooldown — blocks this (doi, host) for the rest of
        // the session.
        // "nopdf" on a protected host is a soft failure: the page loaded but no
        // PDF could be extracted — almost always a paywalled JS-SPA or a page
        // the extractor can't parse.  Apply only a short batch-level cooldown
        // (no negativeCache entry) so subsequent items skip this publisher instead
        // of each generating their own N requests, which triggers Elsevier/Wiley
        // bot-detection after the 3rd–4th consecutive hit from the same IP.
        const isChallenge   = reason === "captcha" || reason === "cloudflare" ||
                              reason === "blocked" || reason === "auth";
        const isSoftFailure = reason === "nopdf";
        if (hostPolicy && hostPolicy.earlyAbortOnChallenge && (isChallenge || isSoftFailure)) {
          _localHostAborts.add(effectiveHost);
          if (isChallenge && ids.doi) {
            ZotFetch.negativeCache.add(ids.doi, effectiveHost, reason, hostPolicy);
          }
          const penaltyMs = isSoftFailure
            ? Math.min((hostPolicy.negativeCacheTtlAuthMs || 45 * 60 * 1000) / 9, 5 * 60 * 1000)
            : (reason === "auth"
                ? Math.min((hostPolicy.negativeCacheTtlAuthMs || 45 * 60 * 1000) / 3, 15 * 60 * 1000)
                : Math.min((hostPolicy.negativeCacheTtlMs    ||  6 * 60 * 60 * 1000) / 10, 36 * 60 * 1000));
          this.cooldown.applyPenaltyCooldown(effectiveHost, penaltyMs);
          Zotero.debug(
            `[ZotFetch][ProtectedHost] Early abort: host=${effectiveHost} reason=${reason} ` +
            `cooldown=${Math.round(penaltyMs / 60000)} min doi=${ids.doi || "?"} item=${item.id}`
          );
        }

        Zotero.debug(`[ZotFetch] ✗ ${candidate.sourceId} (${effectiveHost}) → ${reason}`);
        continue;
      }

      // 4. Import the resolved PDF.
      const t0 = Date.now();
      const ok = await AttachmentImporter.importResolvedPdf(item, result, candidate.label);
      if (ok) {
        stats.downloaded++;
        const sid = candidate.sourceId;
        Zotero.debug(`[ZotFetch] ✓ ${sid} (${Date.now() - t0}ms, item ${item.id})`);
        if (result.method === "hidden-browser")  stats.hiddenbrowser++;
        if (sid === "unpaywall")                        stats.unpaywall++;
        else if (sid === "semanticscholar")             stats.semanticscholar++;
        else if (sid === "openalex")                   stats.openalex++;
        else if (sid === "core")                       stats.core++;
        else if (sid === "europepmc")                  stats.europepmc++;
        else if (sid === "internet-archive")           stats.internetarchive++;
        else if (sid === "paperity")                   stats.paperity++;
        else if (sid === "oamg")                       stats.oamg++;
        else if (sid.startsWith("institutional-proxy")) stats.institutional++;
        else if (sid === "capes")                      stats.capes++;
        else                                           stats.oarepository++; // oa-repository / doi-landing / arXiv
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
      new EuropePmcSourceResolver(),
      new CoreSourceResolver(),
      new InternetArchiveSourceResolver(),   // Fatcat API — archived repo copies (priority 84)
      new PaperitySourceResolver(),          // Paperity OA journal aggregator  (priority 81)
      new OaRepositorySourceResolver(),
      new NativeDoiSourceResolver(),         // Zotero Connector-like: translator + proxy
      new DoiLandingSourceResolver(),        // fallback HTML extraction
      new OaMgSourceResolver(),              // OA.mg aggregator landing page    (priority 73)
      new InstitutionalProxySourceResolver()
    ];
    if (mode === "fast")     return fast;
    if (mode === "ultra")    return fast;
    if (mode === "fallback") return [new CapesSourceResolver()];
    // "full" — all sources
    return [...fast, new CapesSourceResolver()];
  }

  /** Return the ordered list of PDFResolvers. */
  static _buildPdfResolvers() {
    return [
      new DirectPDFResolver(),
      new PublisherPatternResolver(),
      new HtmlLandingPDFResolver(),
      // HiddenBrowserPDFResolver is tried last: it spins up a real Gecko
      // browser instance (Zotero.HTTP.processDocuments) so JS challenges
      // (Cloudflare, Akamai) are executed and solved before the DOM is
      // inspected.  Only fires when the XHR-based resolvers above already
      // failed — typically because the server returned a challenge page.
      new HiddenBrowserPDFResolver()
    ];
  }

  /**
   * Run a SourceCandidate through matching PDFResolvers until one succeeds.
   */
  static async _resolveCandidate(candidate, resolvers) {
    // Security: reject any non-http(s) URL that may have been returned by a
    // third-party API (Unpaywall, OpenAlex, Semantic Scholar, CORE, …) before
    // it reaches Zotero.HTTP.request or processDocuments.  A file://, data:,
    // or javascript: URL loaded in Zotero's privileged Gecko context could
    // read local files or execute arbitrary code.
    // Empty-string URLs belong to sentinel candidates (native / native-doi)
    // which are handled upstream and never reach this method.
    if (candidate.url && !/^https?:\/\//i.test(candidate.url)) {
      Zotero.debug(`[ZotFetch] _resolveCandidate: blocked non-http(s) URL — ${String(candidate.url).substring(0, 80)}`);
      return { ok: false, failureReason: "network" };
    }
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

  // ── Zotero Connector-like DOI resolver ───────────────────────────────────
  // Delegates to Zotero's built-in DOI-based PDF resolution ("doi" method).
  // Internally uses the translator library + Zotero proxy configuration, the
  // same mechanism the Zotero Connector uses when you click it on a publisher
  // landing page.
  //
  // Institutional IP / VPN: all HTTP requests from Zotero go out via the
  //   authenticated network → publisher serves the PDF directly.
  // Configured Zotero proxy: requests are rewritten to route through the
  //   proxy URL set in Tools → Preferences → Proxies.
  //
  // If Zotero 8 does not support the "doi" method the call returns false
  // harmlessly and the pipeline falls through to DoiLandingSourceResolver.

  static async tryNativeDoi(item) {
    const doi = Utils.normalizeDOI(item.getField("DOI") || "");
    if (!doi) return false;
    try {
      await Zotero.Attachments.addAvailableFile(item, { methods: NATIVE_DOI_METHODS });
    } catch (err) {
      Zotero.debug(`[ZotFetch] tryNativeDoi: ${err?.message || err}`);
    }
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

  // ── Legacy fetchPDF (kept for any edge callers) ───────────────────────────
  // Wraps the candidate system; treat the URL as a direct-pdf or landing-page
  // candidate, resolve it, then import.

  static async fetchPDF(item, url, source) {
    if (!url || !/^https?:\/\//i.test(String(url))) return false;

    const domain = Utils.getDomain(url);
    if (ZotFetchPrefs.isAntiCaptchaMode() && this.cooldown.isDomainCoolingDown(domain)) return false;

    if (source.includes("Institutional") || source.includes("CAPES")) {
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
          : "https://doi.org/"
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
      // Validate year is a 4-digit number before inserting into the filter
      // parameter — prevents query-parameter injection from a crafted item.
      if (year && /^\d{4}$/.test(year)) queryURL += `&filter=from-pub-date:${year},until-pub-date:${year}`;
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
      // encodeURI preserves the '/' separator required by DOI syntax while
      // encoding any special characters that could alter the URL structure.
      try { Zotero.launchURL(`https://doi.org/${encodeURI(info.doi)}`); } catch (e) {}
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

