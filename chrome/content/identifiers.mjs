// chrome/content/identifiers.mjs
// IdentifierExtractor — robustly extracts DOI, PMID, arXiv ID, URL and
// bibliographic fields from a Zotero item.

// Domains that act as aggregators or reference databases: they link TO papers
// but never host the PDF directly. When a DOI is available these URLs are
// silently ignored. When no DOI is available the URL is also discarded so it
// never reaches a PDFResolver, avoiding 404s and captcha loops.
const AGGREGATOR_HOSTS = new Set([
  // General academic search / discovery
  "consensus.app",
  "semanticscholar.org",        // search pages (pdfs.semanticscholar.org is fine)
  "connected-papers.com",
  "connectedpapers.com",
  "inciteful.xyz",
  "elicit.org",
  "scispace.com",
  "typeset.io",
  "lens.org",
  "base-search.net",
  "dimensions.ai",
  "app.dimensions.ai",
  // Google Scholar
  "scholar.google.com",
  "scholar.google.com.br",
  "scholar.google.co.uk",
  "scholar.google.co.in",
  "scholar.google.de",
  "scholar.google.fr",
  "scholar.google.es",
  "scholar.google.com.mx",
  // Login-gated repositories (cannot download without account)
  "researchgate.net",
  "academia.edu",
  // Library catalogues
  "worldcat.org",
  // Subscription databases (no open PDF in URL)
  "scopus.com",
  "webofscience.com",
  "webofknowledge.com",
  // AI / summarisation wrappers
  "perplexity.ai",
  "typeset.io",
  // Reference management import sources
  "zotero.org",
  "endnote.com",
]);

/**
 * @typedef {Object} ResolvedIdentifiers
 * @property {string|undefined} doi       - Normalised DOI (no prefix).
 * @property {string|undefined} pmid      - PubMed ID.
 * @property {string|undefined} arxivId   - arXiv ID, e.g. "2301.00001".
 * @property {string|undefined} url       - Best URL found on the item.
 * @property {string|undefined} title     - Item title.
 * @property {string|undefined} year      - Publication year.
 * @property {string|undefined} firstAuthor - Last name of first creator.
 */

var IdentifierExtractor = {
  /**
   * Extract all identifiers from a Zotero item.
   * @param {Zotero.Item} item
   * @returns {Promise<ResolvedIdentifiers>}
   */
  async fromItem(item) {
    const ids = {};

    // ── DOI ──────────────────────────────────────────────────────────────────
    let doi = Utils.normalizeDOI(item.getField("DOI") || "");

    // Fallback: scan the URL field for DOIs embedded in URLs.
    if (!doi) {
      const urlField = String(item.getField("url") || "").trim();
      const urlDoi = this._extractDoiFromString(urlField);
      if (urlDoi) doi = urlDoi;
    }

    // Fallback: scan the Extra field (common in Zotero imports).
    if (!doi) {
      const extra = String(item.getField("extra") || "").trim();
      const match = extra.match(/^DOI:\s*(.+?)\s*$/im);
      if (match) doi = Utils.normalizeDOI(match[1].replace(/[.,;)\]]+$/, ""));
    }

    if (doi) ids.doi = doi;

    // ── PMID ─────────────────────────────────────────────────────────────────
    const extra = String(item.getField("extra") || "");
    const pmidMatch = extra.match(/PMID:\s*(\d+)/i);
    if (pmidMatch) ids.pmid = pmidMatch[1].trim();

    // ── PMCID ────────────────────────────────────────────────────────────────
    // PubMed Central ID (e.g. "PMC1234567") — its presence guarantees the paper
    // is deposited in PMC and is therefore open access.  Many Zotero translators
    // write "PMCID: PMC1234567" in the Extra field on import.
    const pmcidMatch = extra.match(/PMCID?:\s*(PMC\d+)/i);
    if (pmcidMatch) ids.pmcid = pmcidMatch[1].toUpperCase();

    // ── arXiv ─────────────────────────────────────────────────────────────────
    // Check all fields where Zotero stores arXiv IDs in order of reliability:
    //   1. archiveID  — set by translators for arXiv items ("2301.00001")
    //   2. archiveLocation — sometimes stores "arXiv:2301.00001" (Google Scholar etc.)
    //   3. url field  — arXiv landing or PDF URLs
    //   4. Extra      — catch-all for bulk imports via CrossRef / DOI metadata
    const archiveID = String(item.getField("archiveID") || "");
    if (archiveID) {
      const arxiv = this._extractArxivId(archiveID);
      if (arxiv) ids.arxivId = arxiv;
    }
    if (!ids.arxivId) {
      const archiveLoc = String(item.getField("archiveLocation") || "");
      if (archiveLoc) {
        const arxiv = this._extractArxivId(archiveLoc);
        if (arxiv) ids.arxivId = arxiv;
      }
    }
    if (!ids.arxivId) {
      const urlField = String(item.getField("url") || "");
      const arxiv = this._extractArxivId(urlField);
      if (arxiv) ids.arxivId = arxiv;
    }
    if (!ids.arxivId) {
      const arxiv = this._extractArxivId(extra);
      if (arxiv) ids.arxivId = arxiv;
    }

    // ── URL resolution ────────────────────────────────────────────────────────
    // ids.itemUrl  — the raw URL from the Zotero URL field (used by
    //                OaRepositorySourceResolver to check safe OA hosts).
    // ids.url      — the canonical "best URL" for this paper:
    //                • When a DOI is known   → https://doi.org/{doi}
    //                • When no DOI + item URL is not an aggregator → item URL
    //                • Aggregator URLs (consensus.app, scholar.google.com, etc.)
    //                  are NEVER used as download sources.
    const urlField = String(item.getField("url") || "").trim();
    if (urlField && /^https?:\/\//i.test(urlField)) {
      ids.itemUrl = urlField;
    }

    if (doi) {
      // DOI always wins — use canonical doi.org URL regardless of what the
      // item URL field contains.
      ids.url = `https://doi.org/${doi}`;
      if (ids.itemUrl) {
        const itemDomain = Utils.getDomain(ids.itemUrl);
        if (itemDomain && this._isAggregatorHost(itemDomain)) {
          Zotero.debug(`[ZotFetch:ids] Aggregator URL ignored (${itemDomain}) — DOI ${doi} will be used`);
        }
      }
    } else if (ids.itemUrl) {
      const itemDomain = Utils.getDomain(ids.itemUrl);
      if (this._isAggregatorHost(itemDomain)) {
        // No DOI and item URL is an aggregator — discard it entirely so the
        // pipeline does not waste a request on a page that never has a PDF.
        Zotero.debug(`[ZotFetch:ids] Aggregator URL discarded (${itemDomain}) — no DOI found`);
      } else {
        ids.url = ids.itemUrl;
      }
    }

    // ── Bibliographic metadata ────────────────────────────────────────────────
    const title = String(item.getField("title") || "").trim();
    if (title) ids.title = title;

    const year = String(item.getField("year") || "").trim();
    if (year) ids.year = year;

    const creators = item.getCreators ? item.getCreators() : [];
    if (creators.length > 0) {
      const first = creators[0];
      const name = (first.lastName || first.name || "").trim();
      if (name) ids.firstAuthor = name;
    }

    return ids;
  },

  // ── Internal helpers ───────────────────────────────────────────────────────

  // Returns true when the given domain is a known aggregator/reference site.
  _isAggregatorHost(domain) {
    if (!domain) return false;
    for (const host of AGGREGATOR_HOSTS) {
      if (domain === host || domain.endsWith(`.${host}`)) return true;
    }
    return false;
  },

  _extractDoiFromString(str) {
    if (!str) return null;
    const match = str.match(/(?:doi\.org\/|DOI:|doi:)\s*(10\.\d{4,}\/\S+)/i);
    if (match) return Utils.normalizeDOI(match[1].replace(/[.,;)\]]+$/, ""));
    // Plain DOI without prefix
    const plainMatch = str.match(/\b(10\.\d{4,}\/\S+)/);
    if (plainMatch) return Utils.normalizeDOI(plainMatch[1].replace(/[.,;)\]]+$/, ""));
    return null;
  },

  _extractArxivId(str) {
    if (!str) return null;
    // arxiv.org URL — new-style (post-2007): "https://arxiv.org/abs/2301.00001"
    // Must check the .org/ URL pattern explicitly: the generic prefix check
    // below uses [:/\s]+ which stops at 'o' in "arxiv.org" and fails.
    let m = str.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,}(?:v\d+)?)/i);
    if (m) return m[1];
    // arxiv.org URL — old-style (pre-2007): "https://arxiv.org/abs/hep-ph/0601001"
    m = str.match(/arxiv\.org\/(?:abs|pdf)\/([a-z][a-z.-]+\/\d{7}(?:v\d+)?)/i);
    if (m) return m[1];
    // Explicit prefix — new-style: "arXiv:2301.00001", "arxiv: 2301.00001"
    m = str.match(/arxiv[:/\s]+(\d{4}\.\d{4,}(?:v\d+)?)/i);
    if (m) return m[1];
    // Explicit prefix — old-style: "arXiv:hep-ph/0601001"
    m = str.match(/arxiv[:/\s]+([a-z][a-z.-]+\/\d{7}(?:v\d+)?)/i);
    if (m) return m[1];
    // Bare archiveID field — new-style: "2301.00001" (set by Zotero translators)
    if (/^\d{4}\.\d{4,}(?:v\d+)?$/.test(str.trim())) return str.trim();
    // Bare archiveID field — old-style: "hep-ph/0601001"
    if (/^[a-z][a-z.-]+\/\d{7}(?:v\d+)?$/.test(str.trim())) return str.trim();
    return null;
  }
};

this.IdentifierExtractor = IdentifierExtractor;
