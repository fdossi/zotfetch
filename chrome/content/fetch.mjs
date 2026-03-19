// chrome/content/fetch.mjs
// PDF fetching: Native, Unpaywall, CAPES, Sci-Hub with anti-captcha controls

const NATIVE_METHODS = ["oa"];
const SAFE_UA = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Zotero/8.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0"
];
const SAFE_OA_HOSTS = new Set([
  "arxiv.org", "ar5iv.labs.arxiv.org",
  "europepmc.org", "ncbi.nlm.nih.gov",
  "biorxiv.org", "medrxiv.org", "chemrxiv.org",
  "hal.science", "hal.archives-ouvertes.fr",
  "zenodo.org", "figshare.com",
  "core.ac.uk", "doaj.org", "oapen.org",
  "psyarxiv.com", "osf.io", "ssrn.com",
  "mdpi.com"
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
      `${this.getProgressStatus(stats, batch.length, batch.length, true)} Concluído: ${stats.downloaded} baixados (nativo ${stats.native}, Unpaywall ${stats.unpaywall}, Institucional ${stats.institutional}, Sci-Hub ${stats.scihub}, CAPES ${stats.capes}) | pendentes passo 2 ${stats.deferred} | DOI recuperado ${stats.doiRecovered} | não encontrado ${stats.notFound} | erros ${stats.failed} | captcha ${stats.captcha}`
    );
    progress.setProgress(100);
    progressWindow.startCloseTimer(10000);
  }

  static async processItem(item, stats, mode = "full") {
    ZotFetch.failedItems.delete(String(item.id));
    if (await this.hasPDF(item)) {
      return "already";
    }
    ZotFetch._lastFetchReason = "nopdf";

    let doi = Utils.normalizeDOI(item.getField("DOI"));
    if (!doi && mode !== "ultra") {
      const lookedUp = await this.lookupDOI(item);
      if (lookedUp) {
        doi = lookedUp;
        stats.doiRecovered++;
      }
    }

    if (mode === "fast") {
      if (await this.tryNative(item)) {
        stats.downloaded++;
        stats.native++;
        return "native";
      }

      if (await this.tryUnpaywall(item, doi)) {
        stats.downloaded++;
        stats.unpaywall++;
        return "unpaywall";
      }

      if (ZotFetchPrefs.isInstitutionalProxyEnabled() && await this.tryInstitutionalProxy(item, doi)) {
        stats.downloaded++;
        stats.institutional++;
        return "institutional";
      }

      return "deferred";
    }

    if (mode === "ultra") {
      if (await this.tryNative(item)) {
        stats.downloaded++;
        stats.native++;
        return "native";
      }

      if (await this.tryUnpaywall(item, doi)) {
        stats.downloaded++;
        stats.unpaywall++;
        return "unpaywall";
      }

      if (ZotFetchPrefs.isInstitutionalProxyEnabled() && await this.tryInstitutionalProxy(item, doi)) {
        stats.downloaded++;
        stats.institutional++;
        return "institutional";
      }

      if (ZotFetchPrefs.isScihubEnabled() && doi && await this.tryScihub(item, doi, 1)) {
        stats.downloaded++;
        stats.scihub++;
        return "scihub";
      }

      return "deferred";
    }

    if (mode === "fallback") {
      if (ZotFetchPrefs.isScihubEnabled() && await this.tryScihub(item, doi, ZotFetchPrefs.getFastMirrorLimit())) {
        stats.downloaded++;
        stats.scihub++;
        return "scihub";
      }

      if (ZotFetchPrefs.isCapesEnabled() && await this.tryCapes(item, doi)) {
        stats.downloaded++;
        stats.capes++;
        return "capes";
      }

      ZotFetch.failedItems.set(String(item.id), { item, reason: ZotFetch._lastFetchReason, doi: doi || "" });
      stats.notFound++;
      return "notfound";
    }

    if (await this.tryNative(item)) {
      stats.downloaded++;
      stats.native++;
      return "native";
    }

    if (await this.tryUnpaywall(item, doi)) {
      stats.downloaded++;
      stats.unpaywall++;
      return "unpaywall";
    }

    if (ZotFetchPrefs.isInstitutionalProxyEnabled() && await this.tryInstitutionalProxy(item, doi)) {
      stats.downloaded++;
      stats.institutional++;
      return "institutional";
    }

    if (ZotFetchPrefs.isScihubEnabled() && await this.tryScihub(item, doi)) {
      stats.downloaded++;
      stats.scihub++;
      return "scihub";
    }

    if (ZotFetchPrefs.isCapesEnabled() && await this.tryCapes(item, doi)) {
      stats.downloaded++;
      stats.capes++;
      return "capes";
    }

    ZotFetch.failedItems.set(String(item.id), { item, reason: ZotFetch._lastFetchReason, doi: doi || "" });
    stats.notFound++;
    return "notfound";
  }

  static async tryNative(item) {
    if (!Zotero.Attachments.canFindFileForItem(item)) {
      return false;
    }

    await Zotero.Attachments.addAvailableFile(item, {
      methods: NATIVE_METHODS
    });
    return this.hasPDF(item);
  }

  static async tryUnpaywall(item, doi) {
    const email = ZotFetchPrefs.getUnpaywallEmail();
    if (!doi || !email) {
      return false;
    }

    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;

    try {
      const resp = await Zotero.HTTP.request("GET", url, {
        responseType: "json",
        timeout: ZotFetchPrefs.getUnpaywallTimeoutMs()
      });
      this.cooldown.markDomainSuccess("api.unpaywall.org");
      const data = resp.response;
      const urls = this.getUnpaywallPDFs(data).sort((a, b) => {
        const safeA = this.isSafeOAHost(Utils.getDomain(a)) ? 1 : 0;
        const safeB = this.isSafeOAHost(Utils.getDomain(b)) ? 1 : 0;
        return safeB - safeA;
      });

      for (const pdfUrl of urls) {
        if (await this.fetchPDF(item, pdfUrl, "Unpaywall")) {
          return true;
        }
      }
    } catch (error) {
      if (Utils.isCaptchaError(error)) {
        this.cooldown.markDomainCaptcha("api.unpaywall.org");
      } else {
        this.cooldown.markDomainNonCaptcha("api.unpaywall.org");
      }
      Zotero.logError(error);
    }

    return false;
  }

  static async tryInstitutionalProxy(item, doi) {
    if (!doi) {
      return false;
    }
    const proxyUrl = ZotFetchPrefs.getInstitutionalProxyUrl();
    if (!proxyUrl || !proxyUrl.trim()) {
      return false;
    }

    const doiURL = `https://doi.org/${String(doi).trim()}`;
    const institutionalUrl = this.buildProxyTargetURL(proxyUrl, doiURL);

    Zotero.debug(`[ZotFetch] Trying institutional proxy: ${proxyUrl.substring(0, 50)}...`);
    return this.fetchPDF(item, institutionalUrl, "Institutional/Proxy");
  }

  static async tryCapes(item, doi) {
    if (!doi) {
      return false;
    }
    const proxy = ZotFetchPrefs.getProxyUrl();
    const doiURL = `https://doi.org/${String(doi).trim()}`;
    const url = proxy ? this.buildProxyTargetURL(proxy, doiURL) : doiURL;
    return this.fetchPDF(item, url, "CAPES/DOI");
  }

  static async tryScihub(item, doi, maxMirrors = null) {
    if (!doi) {
      return false;
    }

    // Multiple Sci-Hub mirrors, ordered by reliability
    const mirrors = [
      "sci-hub.se",    // Most stable
      "sci-hub.st",
      "sci-hub.ru",
      "sci-hub.it",
      "sci-hub.hkvisa.net",
      "sci-hub.41849.com",
      "sci-hub.p2p.cx"
    ];
    let selectedMirrors = mirrors;
    if (Number.isFinite(maxMirrors) && maxMirrors > 0) {
      selectedMirrors = mirrors.slice(0, maxMirrors);
    }

    for (const mirror of selectedMirrors) {
      const url = `https://${mirror}/${doi}`;
      if (await this.fetchPDF(item, url, "Sci-Hub")) {
        return true;
      }
    }
    return false;
  }

  static async fetchPDF(item, url, source) {
    if (!url || !/^https?:\/\//i.test(String(url))) {
      return false;
    }

    const domain = Utils.getDomain(url);
    if (ZotFetchPrefs.isAntiCaptchaMode() && this.cooldown.isDomainCoolingDown(domain)) {
      return false;
    }

    await this.cooldown.honorDomainGap(domain, ZotFetchPrefs);

    try {
      const headers = {
        "User-Agent": SAFE_UA[0],
        "Accept": "application/pdf,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "DNT": "1"
      };

      // Different referer for institutional vs public sources
      if (source.includes("Institutional") || source.includes("CAPES")) {
        headers["Referer"] = "https://scholar.google.com/";
      } else if (source.includes("Sci-Hub")) {
        headers["Referer"] = "https://sci-hub.se/";
      } else {
        headers["Referer"] = "https://doi.org/";
      }

      await Zotero.Attachments.importFromURL({
        libraryID: item.libraryID,
        parentItemID: item.id,
        title: `${source} PDF`,
        url,
        contentType: "application/pdf",
        headers
      });
      const hasPDF = await this.hasPDF(item);
      if (hasPDF) {
        this.cooldown.markDomainSuccess(domain);
      } else {
        this.cooldown.markDomainNonCaptcha(domain);
      }
      return hasPDF;
    } catch (error) {
      const reason = this.classifyError(error);
      const REASON_PRIORITY = { captcha: 5, auth: 4, blocked: 3, timeout: 2, network: 1, nopdf: 0 };
      if ((REASON_PRIORITY[reason] || 0) > (REASON_PRIORITY[ZotFetch._lastFetchReason] || 0)) {
        ZotFetch._lastFetchReason = reason;
      }
      if (reason === "captcha") {
        this.cooldown.markDomainCaptcha(domain);
      } else {
        this.cooldown.markDomainNonCaptcha(domain);
      }
      Zotero.logError(error);
      return false;
    }
  }

  static buildProxyTargetURL(proxyBase, targetURL) {
    const base = String(proxyBase || "").trim();
    const target = String(targetURL || "").trim();
    if (!base || !target) {
      return target;
    }

    if (base.includes("{url}")) {
      return base.replace("{url}", encodeURIComponent(target));
    }

    if (/([?&]url=)$/i.test(base)) {
      return `${base}${encodeURIComponent(target)}`;
    }

    if (base.includes("?")) {
      const sep = base.endsWith("?") || base.endsWith("&") ? "" : "&";
      return `${base}${sep}url=${encodeURIComponent(target)}`;
    }

    const sep = base.endsWith("/") ? "" : "/";
    return `${base}${sep}login?url=${encodeURIComponent(target)}`;
  }

  static async lookupDOI(item) {
    const title = String(item.getField("title") || "").trim();
    if (!title) {
      return "";
    }

    const creators = item.getCreators ? item.getCreators() : [];
    const firstAuthor = creators.length > 0
      ? (creators[0].lastName || creators[0].name || "").trim()
      : "";
    const year = String(item.getField("year") || "").trim();
    const email = ZotFetchPrefs.getUnpaywallEmail();
    if (!email) {
      return "";
    }

    try {
      let queryURL = `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}`;
      if (firstAuthor) {
        queryURL += `&query.author=${encodeURIComponent(firstAuthor)}`;
      }
      if (year) {
        queryURL += `&filter=from-pub-date:${year},until-pub-date:${year}`;
      }
      queryURL += `&rows=3&select=DOI,title,published&mailto=${encodeURIComponent(email)}`;

      const response = await Zotero.HTTP.request("GET", queryURL, {
        responseType: "json",
        timeout: ZotFetchPrefs.getCrossrefTimeoutMs()
      });

      const results = response.response?.message?.items;
      if (!Array.isArray(results) || !results.length) {
        return "";
      }

      for (const candidate of results) {
        const candidateDOI = String(candidate.DOI || "").trim();
        if (!candidateDOI) {
          continue;
        }
        const candidateYear = String(candidate.published?.["date-parts"]?.[0]?.[0] || "");
        if (year && candidateYear && candidateYear !== year) {
          continue;
        }

        const candidateTitles = Array.isArray(candidate.title) ? candidate.title : [];
        let best = { match: false, score: 0 };
        for (const candidateTitle of candidateTitles) {
          const sim = Utils.isTitleSimilar(candidateTitle, title);
          if (sim.score > best.score) {
            best = sim;
          }
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

  static async hasPDF(item) {
    const attachmentIDs = item.getAttachments ? item.getAttachments() : [];
    if (!attachmentIDs || !attachmentIDs.length) {
      return false;
    }

    const atts = await Zotero.Items.getAsync(attachmentIDs);
    return atts.some((att) => {
      if (!att) {
        return false;
      }
      if (att.isPDFAttachment?.()) {
        return true;
      }
      return att.attachmentContentType === "application/pdf";
    });
  }

  static getUnpaywallPDFs(data) {
    const list = [
      data?.best_oa_location?.url_for_pdf,
      ...(Array.isArray(data?.oa_locations) ? data.oa_locations.map((loc) => loc?.url_for_pdf) : [])
    ];
    return list.filter(Boolean);
  }

  static isSafeOAHost(domain) {
    if (!domain) {
      return false;
    }
    for (const host of SAFE_OA_HOSTS) {
      if (domain === host || domain.endsWith(`.${host}`)) {
        return true;
      }
    }
    return false;
  }

  static getItemLabel(item) {
    const title = String(item.getField("title") || "Sem título").trim();
    const year = String(item.getField("year") || "").trim();
    return year ? `${title} (${year})` : title;
  }

  static getProgressStatus(stats, total, processed = 0, isFinal = false) {
    const t = Math.max(1, parseInt(total, 10) || 1);
    const p = Math.max(0, parseInt(processed, 10) || 0);

    if (!isFinal && p < 3) {
      return "🔵";
    }

    if (isFinal) {
      const finalRate = stats.downloaded / t;
      const highFailure = stats.failed >= Math.max(2, Math.ceil(t * 0.25));
      if (highFailure || stats.captcha >= 4 || finalRate < 0.45) {
        return "🔴";
      }
      if (stats.failed > 0 || stats.captcha > 0 || finalRate < 0.8) {
        return "🟡";
      }
      return "🟢";
    }

    const effectiveProcessed = Math.max(1, p);
    const runningRate = stats.downloaded / effectiveProcessed;
    const runningFailureRate = stats.failed / effectiveProcessed;

    if (effectiveProcessed >= 5 && (runningFailureRate >= 0.35 || stats.captcha >= 3 || runningRate < 0.3)) {
      return "🔴";
    }
    if (effectiveProcessed >= 3 && (stats.failed > 0 || stats.captcha > 0 || runningRate < 0.65)) {
      return "🟡";
    }
    return "🟢";
  }

  static classifyError(error) {
    const msg = String(error?.message || error || "").toLowerCase();
    const status = error?.status || error?.xmlhttp?.status || 0;
    if (Utils.isCaptchaError(error)) return "captcha";
    if (status === 401 || status === 403 || msg.includes("403") || msg.includes("forbidden") || msg.includes("unauthorized")) return "auth";
    if (status === 429 || msg.includes("429") || msg.includes("too many") || msg.includes("rate limit") || msg.includes("blocked")) return "blocked";
    if (status === 408 || status === 504 || msg.includes("timeout") || msg.includes("timed out")) return "timeout";
    if (status === 404 || msg.includes("404") || msg.includes("not found")) return "nopdf";
    return "network";
  }

  static async runRetryFailed() {
    if (!ZotFetch.failedItems.size) {
      Zotero.alert(null, "ZotFetch", "Nenhum item falho registrado.\nExecute o Batch Download primeiro.");
      return;
    }
    const pending = [];
    for (const info of ZotFetch.failedItems.values()) {
      if (!await this.hasPDF(info.item)) {
        pending.push(info.item);
      }
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

