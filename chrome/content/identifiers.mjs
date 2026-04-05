// chrome/content/identifiers.mjs
// IdentifierExtractor — robustly extracts DOI, PMID, arXiv ID, URL and
// bibliographic fields from a Zotero item.

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

    // ── Best URL ─────────────────────────────────────────────────────────────
    // Priority: attachment URLs, item URL field, DOI-derived URL.
    const urlField = String(item.getField("url") || "").trim();
    if (urlField && /^https?:\/\//i.test(urlField)) {
      ids.url = urlField;
    } else if (doi) {
      ids.url = `https://doi.org/${doi}`;
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
