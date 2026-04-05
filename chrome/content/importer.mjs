// chrome/content/importer.mjs
// AttachmentImporter — imports a resolved PDF into Zotero and validates success.

var AttachmentImporter = {
  /**
   * Import a directly resolved PDF URL into Zotero as an attachment.
   *
   * @param {Zotero.Item}        item        - Parent item.
   * @param {PDFResolutionResult} result      - Successful resolution result.
   * @param {string}             sourceLabel - Label used for the attachment title.
   * @returns {Promise<boolean>} true if the attachment is confirmed as PDF.
   */
  async importResolvedPdf(item, result, sourceLabel) {
    if (!result.ok || !result.finalPdfUrl) return false;

    const url = result.finalPdfUrl;
    if (!/^https?:\/\//i.test(url)) {
      Zotero.debug(`[ZotFetch] AttachmentImporter: invalid URL scheme — ${url.substring(0, 80)}`);
      return false;
    }

    const t0 = Date.now();
    Zotero.debug(`[ZotFetch] AttachmentImporter: importing from ${url.substring(0, 80)} [${sourceLabel}]`);

    try {
      const headers = {
        ...Utils.getStealthHeaders(),
        Accept: "application/pdf,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        DNT: "1",
        ...(result.headers || {})
      };

      await Zotero.Attachments.importFromURL({
        libraryID: item.libraryID,
        parentItemID: item.id,
        title: `${sourceLabel} PDF`,
        url,
        contentType: "application/pdf",
        headers
      });

      const hasPdf = await ZotFetch.hasPDF(item);
      const elapsed = Date.now() - t0;
      if (hasPdf) {
        ZotFetch.cooldown.markDomainSuccess(Utils.getDomain(url));
        Zotero.debug(`[ZotFetch] AttachmentImporter: success in ${elapsed}ms [${sourceLabel}]`);
      } else {
        ZotFetch.cooldown.markDomainNonCaptcha(Utils.getDomain(url));
        Zotero.debug(`[ZotFetch] AttachmentImporter: importFromURL completed but no PDF found (${elapsed}ms)`);
      }
      return hasPdf;
    } catch (error) {
      const elapsed = Date.now() - t0;
      Zotero.debug(`[ZotFetch] AttachmentImporter: error after ${elapsed}ms — ${error?.message || error}`);
      Zotero.logError(error);
      return false;
    }
  }
};

this.AttachmentImporter = AttachmentImporter;
