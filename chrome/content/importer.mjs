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
  async importResolvedPdf(item, result, sourceLabel, networkPolicy = {}) {
    if (!result.ok || !result.finalPdfUrl) return false;

    const url = result.finalPdfUrl;
    if (!Utils.isSafeDestinationURL(url, networkPolicy)) {
      Zotero.debug(`[ZotFetch] AttachmentImporter: unsafe URL — ${Utils.urlForLog(url)}`);
      return false;
    }

    const t0 = Date.now();
    Zotero.debug(`[ZotFetch] AttachmentImporter: importing from ${Utils.urlForLog(url)} [${sourceLabel}]`);

    try {
      const headers = {
        ...Utils.getStealthHeaders(),
        Accept: "application/pdf,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        DNT: "1",
        ...(result.headers || {})
      };

      // Keep the validated bytes. Zotero.importFromURL starts a new unchecked
      // browser download and logs the full URL, including signed query values.
      let blob = result.pdfBlob;
      if (!blob) {
        const response = await Utils.safeRequest("GET", url, {
          responseType: "blob", timeout: ZotFetchPrefs.getRequestTimeoutMs(),
          headers, zotfetchPolicy: networkPolicy
        });
        if (!/application\/pdf/i.test(response.getResponseHeader?.("Content-Type") || "")) return false;
        blob = response.response;
      }
      if (!await this._hasPdfSignature(blob)) return false;
      await this._importPdfBlob(item, blob, url, `${sourceLabel} PDF`);

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
      Zotero.debug(`[ZotFetch] AttachmentImporter: error after ${elapsed}ms — ${Utils.errorForLog(error)}`);
      Zotero.debug(Utils.errorForLog(error));
      return false;
    }
  },

  async _hasPdfSignature(blob) {
    if (!blob?.slice || !blob.size) return false;
    const bytes = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
    for (let i = 0; i <= bytes.length - 5; i++) {
      if (bytes[i] === 37 && bytes[i + 1] === 80 && bytes[i + 2] === 68 &&
          bytes[i + 3] === 70 && bytes[i + 4] === 45) return true;
    }
    return false;
  },

  async _importPdfBlob(item, blob, url, title) {
    const attachments = Zotero.Attachments;
    if (!attachments.createTemporaryStorageDirectory ||
        !attachments.createURLAttachmentFromTemporaryStorageDirectory ||
        !Zotero.File?.putContentsAsync || typeof OS === "undefined") {
      throw new Error("Zotero PDF storage API unavailable");
    }
    const directory = (await attachments.createTemporaryStorageDirectory()).path;
    const filename = "ZotFetch.pdf";
    try {
      const filePath = OS.Path.join(directory, filename);
      await Zotero.File.putContentsAsync(filePath, blob);
      if (Zotero.MIME?.getMIMETypeFromFile && Zotero.File.pathToFile) {
        const detectedType = await Zotero.MIME.getMIMETypeFromFile(Zotero.File.pathToFile(filePath));
        if (detectedType !== "application/pdf") throw new Error("Downloaded file is not a PDF");
      }
      await attachments.createURLAttachmentFromTemporaryStorageDirectory({
        directory,
        libraryID: item.libraryID,
        parentItemID: item.id,
        title,
        filename,
        url,
        contentType: "application/pdf"
      });
    } finally {
      // On success Zotero moves the directory into attachment storage.
      await OS.File.remove(OS.Path.join(directory, filename), { ignoreAbsent: true });
      await OS.File.removeDir(directory, { ignoreAbsent: true });
    }
  }
};

this.AttachmentImporter = AttachmentImporter;
