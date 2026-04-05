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
      const match = extra.match(/^DOI:\s*(.+)$/im);
      if (match) doi = Utils.normalizeDOI(match[1]);
    }

    if (doi) ids.doi = doi;

    // ── PMID ─────────────────────────────────────────────────────────────────
    const extra = String(item.getField("extra") || "");
    const pmidMatch = extra.match(/PMID:\s*(\d+)/i);
    if (pmidMatch) ids.pmid = pmidMatch[1].trim();

    // ── arXiv ─────────────────────────────────────────────────────────────────
    const archiveID = String(item.getField("archiveID") || "");
    if (archiveID) {
      const arxiv = this._extractArxivId(archiveID);
      if (arxiv) ids.arxivId = arxiv;
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
    if (match) return Utils.normalizeDOI(match[1]);
    // Plain DOI without prefix
    const plainMatch = str.match(/\b(10\.\d{4,}\/\S+)/);
    if (plainMatch) return Utils.normalizeDOI(plainMatch[1]);
    return null;
  },

  _extractArxivId(str) {
    if (!str) return null;
    // Matches: arxiv:2301.00001, arxiv.org/abs/2301.00001, arxiv.org/pdf/2301.00001
    const match = str.match(/arxiv[./: ]+(?:abs\/|pdf\/)?(\d{4}\.\d{4,}(?:v\d+)?)/i);
    return match ? match[1] : null;
  }
};

this.IdentifierExtractor = IdentifierExtractor;
