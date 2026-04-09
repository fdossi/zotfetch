// chrome/content/pdf-resolvers.mjs
// PDFResolver implementations — each resolver accepts a SourceCandidate and
// tries to produce a final, validated PDF URL ready for import.
//
// PDFResolutionResult shape:
//   ok            {boolean}
//   finalPdfUrl?  {string}
//   method?       {"direct"|"html-meta"|"html-anchor"|"iframe"|"publisher-pattern"|"scihub"}
//   headers?      {Object}
//   failureReason?  {"nopdf"|"auth"|"captcha"|"blocked"|"timeout"|"network"|"cloudflare"}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _resolveUrl(raw, base) {
  if (!raw) return null;
  try {
    return new URL(raw, base).href;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers shared by multiple resolvers
// ─────────────────────────────────────────────────────────────────────────────

// Generic PDF link extraction from a parsed DOM — used as a fallback inside
// PublisherPatternResolver so HtmlLandingPDFResolver never needs to re-fetch
// the same URL.  Mirrors the extraction chain of HtmlLandingPDFResolver.
function _genericPdfExtract(doc, base) {
  if (!doc) return null;

  // 1. <meta name="citation_pdf_url">
  const metaSelectors = [
    'meta[name="citation_pdf_url"]',
    'meta[property="citation_pdf_url"]',
    'meta[name="dc.identifier"][scheme="PDF"]',
    'meta[property="og:pdf"]'
  ];
  for (const sel of metaSelectors) {
    const val = doc.querySelector(sel)?.getAttribute("content");
    if (val) { const r = _resolveUrl(val, base); if (r) return r; }
  }

  // 2. <link rel="alternate" type="application/pdf">
  const alt = doc.querySelector('link[rel="alternate"][type="application/pdf"]');
  if (alt) { const r = _resolveUrl(alt.getAttribute("href"), base); if (r) return r; }

  // 3. Embedded viewers
  for (const sel of ["iframe[src]", "embed[src]", "object[data]"]) {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      const raw = el.getAttribute("src") || el.getAttribute("data");
      if (raw && /pdf/i.test(raw)) {
        const r = _resolveUrl(raw.split("#")[0], base);
        if (r) return r;
      }
    }
  }

  // 4. Anchor heuristics
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href") || "";
    const text = (a.textContent || "").trim().toLowerCase();
    if (
      /\.pdf(\?|#|$)/i.test(href) ||
      /\/(pdf|download)\//i.test(href) ||
      /\b(pdf|download pdf|full[- ]text pdf|view pdf|get pdf)\b/i.test(text)
    ) {
      const r = _resolveUrl(href, base);
      if (r) return r;
    }
  }

  return null;
}

function _classifyHttpError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  const status = error?.status || error?.xmlhttp?.status || 0;
  if (status === 403 && (msg.includes("cf-challenge") || msg.includes("cf_chl") ||
      msg.includes("turnstile") || msg.includes("ray id"))) return "cloudflare";
  if (Utils.isCaptchaError(error)) return "captcha";
  if (status === 401 || status === 403 || msg.includes("forbidden") || msg.includes("unauthorized")) return "auth";
  if (status === 429 || msg.includes("too many") || msg.includes("rate limit") || msg.includes("blocked")) return "blocked";
  if (status === 408 || status === 504 || msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  return "network";
}

// ─────────────────────────────────────────────────────────────────────────────
// DirectPDFResolver
// Used when candidate.kind === "direct-pdf".
// Skips HEAD for protected publisher hosts (HEAD often returns 405 or wrong
// Content-Type on Elsevier/Wiley etc., causing false rejections).
// After GET: checks for challenge page in the response body when Content-Type
// is not application/pdf (fixes missed captcha signals on HTTP 200 responses).
// ─────────────────────────────────────────────────────────────────────────────
var DirectPDFResolver = class {
  canResolve(candidate) {
    return candidate.kind === "direct-pdf";
  }

  async resolve(candidate, ctx) {
    const t0 = Date.now();
    const domain = Utils.getDomain(candidate.url);
    const policy = ProtectedHosts.getHostPolicy(domain);
    ctx.logger(`[DirectPDFResolver] Checking ${candidate.url.substring(0, 80)}`);

    // Skip HEAD for protected hosts: it frequently returns 405, wrong
    // Content-Type, or triggers bot detection without delivering a PDF.
    const skipHead = policy && policy.allowHead === false;

    if (!skipHead) {
      try {
        const resp = await Zotero.HTTP.request("HEAD", candidate.url, {
          timeout: ctx.timeoutMs,
          headers: candidate.headers || {}
        });
        const ct = resp.getResponseHeader?.("Content-Type") || "";
        if (/application\/pdf/i.test(ct)) {
          ctx.logger(`[DirectPDFResolver] HEAD confirmed PDF (${Date.now() - t0}ms)`);
          return { ok: true, finalPdfUrl: candidate.url, method: "direct", headers: candidate.headers };
        }
      } catch (_) {
        // HEAD not supported or failed — continue to GET.
      }
    }

    // GET with Accept: application/pdf.
    try {
      const resp = await Zotero.HTTP.request("GET", candidate.url, {
        timeout: ctx.timeoutMs,
        headers: {
          Accept: "application/pdf,*/*;q=0.8",
          ...(candidate.headers || {})
        }
      });
      const ct = resp.getResponseHeader?.("Content-Type") || "";
      if (/application\/pdf/i.test(ct)) {
        ctx.logger(`[DirectPDFResolver] GET confirmed PDF (${Date.now() - t0}ms)`);
        return { ok: true, finalPdfUrl: candidate.url, method: "direct", headers: candidate.headers };
      }
      // Non-PDF response: check for challenge/auth-wall in the body.
      // ScienceDirect and others return HTTP 200 with a bot-detection page.
      const body = typeof resp.responseText === "string" ? resp.responseText : "";
      if (body) {
        const challengeReason = ProtectedHosts.detectChallengeInText(body);
        if (challengeReason) {
          ctx.logger(`[DirectPDFResolver] Challenge page (${challengeReason}) detected on ${domain}`);
          return { ok: false, failureReason: challengeReason };
        }
      }
      ctx.logger(`[DirectPDFResolver] Non-PDF Content-Type: ${ct}`);
      return { ok: false, failureReason: "nopdf" };
    } catch (error) {
      const reason = _classifyHttpError(error);
      ctx.logger(`[DirectPDFResolver] Error: ${reason}`);
      return { ok: false, failureReason: reason };
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PublisherPatternResolver
// Used when candidate.kind === "landing-page" and the host matches a known
// publisher pattern. Falls back to HtmlLandingPDFResolver if no rule matches.
// ─────────────────────────────────────────────────────────────────────────────

// Each rule has: hostPattern, extract(doc, baseUrl) → string|null
const PUBLISHER_RULES = [
  {
    // Springer / SpringerLink
    hostPattern: /springer\.com|link\.springer\.com/i,
    extract(doc, base) {
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      if (meta) return _resolveUrl(meta, base);
      const a = doc.querySelector('a.c-pdf-download__link, a[data-track-action="download pdf"]');
      const href = a?.getAttribute("href");
      return href ? _resolveUrl(href, base) : null;
    }
  },
  {
    // Nature.com
    hostPattern: /nature\.com/i,
    extract(doc, base) {
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      if (meta) return _resolveUrl(meta, base);
      const a = doc.querySelector('a[href$=".pdf"], a[data-article-pdf]');
      const href = a?.getAttribute("href");
      return href ? _resolveUrl(href, base) : null;
    }
  },
  {
    // Wiley Online Library
    hostPattern: /onlinelibrary\.wiley\.com/i,
    extract(doc, base) {
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      if (meta) return _resolveUrl(meta, base);
      const a = doc.querySelector('a.pdf-download, a[title="PDF"]');
      const href = a?.getAttribute("href");
      return href ? _resolveUrl(href, base) : null;
    }
  },
  {
    // Taylor & Francis
    hostPattern: /tandfonline\.com/i,
    extract(doc, base) {
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      if (meta) return _resolveUrl(meta, base);
      const a = doc.querySelector('a[href*="/pdf/"]');
      const href = a?.getAttribute("href");
      return href ? _resolveUrl(href, base) : null;
    }
  },
  {
    // ACS Publications
    hostPattern: /pubs\.acs\.org/i,
    extract(doc, base) {
      const a = doc.querySelector('a[href*="/doi/pdf/"], a.pdf-button');
      const href = a?.getAttribute("href");
      return href ? _resolveUrl(href, base) : null;
    }
  },
  {
    // IEEE Xplore
    hostPattern: /ieeexplore\.ieee\.org/i,
    extract(doc, base) {
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      if (meta) return _resolveUrl(meta, base);
      // IEEE often embeds PDF URL in a JSON config block
      const scripts = Array.from(doc.querySelectorAll("script:not([src])"));
      for (const s of scripts) {
        const m = s.textContent.match(/"pdfUrl"\s*:\s*"([^"]+\.pdf[^"]*)"/i);
        if (m) return _resolveUrl(m[1], base);
      }
      return null;
    }
  },
  {
    // MDPI
    hostPattern: /mdpi\.com/i,
    extract(doc, base) {
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      if (meta) return _resolveUrl(meta, base);
      const a = doc.querySelector('a.oa_logo_link, a[href*="/pdf"]');
      const href = a?.getAttribute("href");
      return href ? _resolveUrl(href, base) : null;
    }
  },
  {
    // Frontiers
    hostPattern: /frontiersin\.org/i,
    extract(doc, base) {
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      if (meta) return _resolveUrl(meta, base);
      const a = doc.querySelector('a[href$=".pdf"]');
      const href = a?.getAttribute("href");
      return href ? _resolveUrl(href, base) : null;
    }
  },
  {
    // ScienceDirect / Elsevier
    hostPattern: /sciencedirect\.com|linkinghub\.elsevier\.com/i,
    extract(doc, base) {
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      if (meta) return _resolveUrl(meta, base);
      // ScienceDirect embeds the PDF URL in a JS config; try a regex heuristic.
      const scripts = Array.from(doc.querySelectorAll("script:not([src])"));
      for (const s of scripts) {
        const m = s.textContent.match(/"pdf":\s*\{[^}]*"downloadUrl"\s*:\s*"([^"]+)"/i);
        if (m) return _resolveUrl(m[1].replace(/\\u002F/g, "/"), base);
      }
      return null;
    }
  },
  {
    // SciELO Brazil
    hostPattern: /scielo\.br|scielo\.org/i,
    extract(doc, base) {
      // SciELO embeds a PDF link as <a class="format pdf" href="...">
      const a = doc.querySelector('a.format[href*="pdf"], a[href*="/pdf/"], a[href$=".pdf"]');
      const href = a?.getAttribute("href");
      if (href) return _resolveUrl(href, base);
      // Also check meta citation_pdf_url used on scielo.br
      const meta = doc.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content");
      return meta ? _resolveUrl(meta, base) : null;
    }
  }
];

var PublisherPatternResolver = class {
  canResolve(candidate) {
    if (candidate.kind !== "landing-page") return false;
    const host = Utils.getDomain(candidate.url);
    return PUBLISHER_RULES.some(r => r.hostPattern.test(host));
  }

  async resolve(candidate, ctx) {
    const t0   = Date.now();
    const host  = Utils.getDomain(candidate.url);
    const rule  = PUBLISHER_RULES.find(r => r.hostPattern.test(host));
    const policy = ProtectedHosts.getHostPolicy(host);

    ctx.logger(`[PublisherPatternResolver] host=${host} url=${candidate.url.substring(0, 80)}`);

    let doc;
    try {
      const resp = await Zotero.HTTP.request("GET", candidate.url, {
        responseType: "document",
        timeout: ctx.timeoutMs,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(candidate.headers || {})
        }
      });
      doc = resp.responseXML;
    } catch (error) {
      const reason = _classifyHttpError(error);
      ctx.logger(`[PublisherPatternResolver] Fetch error ${reason} on ${host}`);
      return { ok: false, failureReason: reason };
    }

    if (!doc) return { ok: false, failureReason: "nopdf" };

    // ── Challenge detection — MUST happen before any extraction ───────────
    // Publishers return HTTP 200 with a bot-detection page.  Without this
    // check we'd classify it as "nopdf" and keep retrying the same host.
    const challengeReason = ProtectedHosts.detectChallengeInDoc(doc);
    if (challengeReason) {
      ctx.logger(`[PublisherPatternResolver] Challenge (${challengeReason}) on ${host} (${Date.now() - t0}ms)`);
      // Apply an immediate penalty cooldown so the domain gap is respected.
      if (ctx.cooldown && policy) {
        const penaltyMs = Math.min(
          (challengeReason === "auth"
            ? (policy.negativeCacheTtlAuthMs || 45 * 60 * 1000)
            : (policy.negativeCacheTtlMs    ||  6 * 60 * 60 * 1000)) / 10,
          36 * 60 * 1000  // cap at 36 min per single penalty
        );
        ctx.cooldown.applyPenaltyCooldown(host, penaltyMs);
      }
      return { ok: false, failureReason: challengeReason };
    }

    // ── Publisher-specific extraction ───────────────────────────────────
    let extracted = rule ? rule.extract(doc, candidate.url) : null;

    // ── Generic fallback extraction (same GET — avoids a second request) ─
    // If the publisher-specific rule found nothing, try the generic extraction
    // chain.  HtmlLandingPDFResolver.canResolve() returns false for hosts
    // covered here, so without this fallback those pages would yield no PDF.
    if (!extracted) {
      extracted = _genericPdfExtract(doc, candidate.url);
    }

    if (!extracted) {
      ctx.logger(`[PublisherPatternResolver] No PDF URL found on ${host} (${Date.now() - t0}ms)`);
      return { ok: false, failureReason: "nopdf" };
    }

    ctx.logger(`[PublisherPatternResolver] Extracted: ${extracted.substring(0, 80)} (${Date.now() - t0}ms)`);

    // Pass the landing page URL as Referer so the PDF endpoint recognises
    // the same host context — critical for auth-gated Elsevier PDF URLs.
    const validated = await _validatePdf(extracted, candidate.headers, ctx, candidate.url);
    if (!validated) {
      ctx.logger(`[PublisherPatternResolver] Validation failed: ${extracted.substring(0, 80)}`);
      return { ok: false, failureReason: "nopdf" };
    }

    return {
      ok: true,
      finalPdfUrl: extracted,
      method: "publisher-pattern",
      headers: candidate.headers
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HtmlLandingPDFResolver
// Generic HTML→PDF resolver: fetches the landing page, parses the DOM and
// tries progressively weaker extraction strategies.
// ─────────────────────────────────────────────────────────────────────────────
var HtmlLandingPDFResolver = class {
  canResolve(candidate) {
    if (candidate.kind !== "landing-page" || candidate.meta?.scihub) return false;
    // Don't re-fetch URLs already handled by PublisherPatternResolver.
    // That resolver now falls back to generic extraction on the same GET,
    // so issuing a second GET here would be a redundant duplicate request.
    const host = Utils.getDomain(candidate.url);
    if (PUBLISHER_RULES.some(r => r.hostPattern.test(host))) return false;
    return true;
  }

  async resolve(candidate, ctx) {
    const t0 = Date.now();
    ctx.logger(`[HtmlLandingPDFResolver] ${candidate.url.substring(0, 80)}`);

    let doc;
    try {
      const resp = await Zotero.HTTP.request("GET", candidate.url, {
        responseType: "document",
        timeout: ctx.timeoutMs,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...(candidate.headers || {})
        }
      });
      doc = resp.responseXML;
    } catch (error) {
      const reason = _classifyHttpError(error);
      ctx.logger(`[HtmlLandingPDFResolver] Fetch error: ${reason}`);
      return { ok: false, failureReason: reason };
    }

    if (!doc) return { ok: false, failureReason: "nopdf" };

    // ── Challenge detection ─────────────────────────────────────────────
    // doi.org landing pages may redirect to a protected publisher before
    // serving a 200 challenge page; detect it here so callers get the right
    // failure reason and can apply cooldown/negative-cache logic.
    const challengeReason = ProtectedHosts.detectChallengeInDoc(doc);
    if (challengeReason) {
      const host = Utils.getDomain(candidate.url);
      ctx.logger(`[HtmlLandingPDFResolver] Challenge (${challengeReason}) via ${host} (${Date.now() - t0}ms)`);
      return { ok: false, failureReason: challengeReason };
    }

    const extracted =
      this._fromMeta(doc, candidate.url) ||
      this._fromAlternate(doc, candidate.url) ||
      this._fromEmbed(doc, candidate.url) ||
      this._fromAnchor(doc, candidate.url);

    if (!extracted) {
      ctx.logger(`[HtmlLandingPDFResolver] No PDF link found (${Date.now() - t0}ms)`);
      return { ok: false, failureReason: "nopdf" };
    }

    ctx.logger(`[HtmlLandingPDFResolver] Candidate URL: ${extracted.substring(0, 80)}`);

    const validated = await _validatePdf(extracted, candidate.headers, ctx, null);
    if (!validated) {
      ctx.logger(`[HtmlLandingPDFResolver] Validation failed`);
      return { ok: false, failureReason: "nopdf" };
    }

    ctx.logger(`[HtmlLandingPDFResolver] OK (${Date.now() - t0}ms)`);
    return {
      ok: true,
      finalPdfUrl: extracted,
      method: "html-meta",
      headers: candidate.headers
    };
  }

  _fromMeta(doc, base) {
    const selectors = [
      'meta[name="citation_pdf_url"]',
      'meta[property="citation_pdf_url"]',
      'meta[name="dc.identifier"][scheme="PDF"]',
      'meta[property="og:pdf"]'
    ];
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const value = el?.getAttribute("content");
      if (value) {
        const resolved = _resolveUrl(value, base);
        if (resolved) return resolved;
      }
    }
    return null;
  }

  _fromAlternate(doc, base) {
    const el = doc.querySelector('link[rel="alternate"][type="application/pdf"]');
    const href = el?.getAttribute("href");
    return href ? _resolveUrl(href, base) : null;
  }

  _fromEmbed(doc, base) {
    const selectors = ["iframe[src]", "embed[src]", "object[data]"];
    for (const sel of selectors) {
      for (const el of Array.from(doc.querySelectorAll(sel))) {
        const raw = el.getAttribute("src") || el.getAttribute("data");
        if (raw && /pdf/i.test(raw)) {
          const r = _resolveUrl(raw.split("#")[0], base);
          if (r) return r;
        }
      }
    }
    return null;
  }

  _fromAnchor(doc, base) {
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const text = (a.textContent || "").trim().toLowerCase();
      if (
        /\.pdf(\?|#|$)/i.test(href) ||
        /\/(pdf|download)\//i.test(href) ||
        /\b(pdf|download pdf|full[- ]text pdf|view pdf|get pdf)\b/i.test(text)
      ) {
        const r = _resolveUrl(href, base);
        if (r) return r;
      }
    }
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ScihubPDFResolver
// Handles Sci-Hub landing pages. Extracts the embedded PDF URL and verifies
// the page is not a Cloudflare challenge before attempting download.
// ─────────────────────────────────────────────────────────────────────────────
var ScihubPDFResolver = class {
  canResolve(candidate) {
    return candidate.kind === "landing-page" && !!candidate.meta?.scihub;
  }

  async resolve(candidate, ctx) {
    const t0 = Date.now();
    const mirror = candidate.meta?.mirror || Utils.getDomain(candidate.url);
    ctx.logger(`[ScihubPDFResolver] Mirror ${mirror} → ${candidate.url.substring(0, 80)}`);

    if (ZotFetchPrefs.isAntiCaptchaMode()) {
      await ctx.cooldown.applyProtectedDelay();
    }
    await ctx.cooldown.honorDomainGap(mirror, ZotFetchPrefs);

    try {
      const resp = await Zotero.HTTP.request("GET", candidate.url, {
        responseType: "text",
        timeout: ctx.timeoutMs,
        headers: candidate.headers || {}
      });

      const html = String(resp.response || resp.responseText || "");

      if (ZotFetch.isCloudflareChallengePage(html)) {
        ctx.cooldown.applyPenaltyCooldown(mirror, 60000);
        ctx.logger(`[ScihubPDFResolver] Cloudflare challenge on ${mirror}`);
        return { ok: false, failureReason: "cloudflare" };
      }

      ctx.cooldown.markDomainSuccess(mirror);
      const pdfUrl = ZotFetch.extractScihubPdfUrl(html, `https://${mirror}`);
      if (!pdfUrl) {
        ctx.logger(`[ScihubPDFResolver] No embedded PDF URL on ${mirror}`);
        return { ok: false, failureReason: "nopdf" };
      }

      ctx.logger(`[ScihubPDFResolver] Resolved: ${pdfUrl.substring(0, 80)} (${Date.now() - t0}ms)`);
      return {
        ok: true,
        finalPdfUrl: pdfUrl,
        method: "scihub",
        headers: {
          Referer: `https://${mirror}/`,
          ...Utils.getStealthHeaders()
        }
      };
    } catch (error) {
      const reason = _classifyHttpError(error);
      if (reason === "cloudflare" || reason === "captcha") {
        ctx.cooldown.applyPenaltyCooldown(mirror, 60000);
      } else {
        ctx.cooldown.markDomainNonCaptcha(mirror);
      }
      ctx.logger(`[ScihubPDFResolver] Error ${reason} on ${mirror}`);
      return { ok: false, failureReason: reason };
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared: validate that a URL actually serves a PDF.
//
// landingUrl (optional) — the publisher page URL that yielded this URL;
//   used as Referer header and for same-domain trust checks.
//
// For protected publisher hosts (policy.allowHead === false) HEAD is skipped
// entirely: their PDF endpoints return 405 / wrong Content-Type / login
// redirects for HEAD, causing false rejections of valid authenticated URLs.
// Elsevier PDF URLs (…/pdfft?…) don't end in .pdf so the fallback extension
// check also fails — they are recognised via looksLikeElsevierPdfUrl().
// ─────────────────────────────────────────────────────────────────────────────
async function _validatePdf(url, headers, ctx, landingUrl) {
  if (!url) return false;
  const domain = Utils.getDomain(url);
  const policy = ProtectedHosts.getHostPolicy(domain);

  // For protected publishers: skip HEAD and trust the extracted URL.
  // The publisher page was fetched successfully (no challenge detected) so
  // a URL found in it is highly likely to be the real PDF endpoint.
  if (policy && policy.allowHead === false) {
    const likelyPdf = /\.pdf(\?|#|$)/i.test(url) || ProtectedHosts.looksLikeElsevierPdfUrl(url);
    // Also trust a URL on the same publisher domain as the landing page.
    const sameDomain = landingUrl ? (Utils.getDomain(landingUrl) === domain) : false;
    if (likelyPdf || sameDomain) {
      ctx.logger(`[validatePdf] Protected host ${domain}: skipping HEAD (url trusted)`);
      return true;
    }
    // Unrecognised URL pattern on a protected host — still try HEAD below.
  }

  try {
    const reqHeaders = { ...(headers || {}) };
    if (landingUrl) reqHeaders["Referer"] = landingUrl;
    const head = await Zotero.HTTP.request("HEAD", url, {
      timeout: ctx.timeoutMs,
      headers: reqHeaders
    });
    const ct = head.getResponseHeader?.("Content-Type") || "";
    return /application\/pdf/i.test(ct);
  } catch (_) {
    // HEAD failed or not supported — accept if URL pattern suggests PDF.
    return /\.pdf(\?|#|$)/i.test(url) || ProtectedHosts.looksLikeElsevierPdfUrl(url);
  }
}

this.DirectPDFResolver = DirectPDFResolver;
this.PublisherPatternResolver = PublisherPatternResolver;
this.HtmlLandingPDFResolver = HtmlLandingPDFResolver;
this.ScihubPDFResolver = ScihubPDFResolver;
