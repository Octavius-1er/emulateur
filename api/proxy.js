"use strict";

const dns = require("node:dns").promises;
const crypto = require("node:crypto");

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function tokenFor(code) {
  return crypto.createHash("sha256").update("octavius:" + code).digest("hex").slice(0, 32);
}

const TOKEN = process.env.ACCESS_CODE ? tokenFor(process.env.ACCESS_CODE) : "";

function sameToken(a, b) {
  return a.length === b.length && a.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function checkAccess(req) {
  if (!TOKEN) {
    if (process.env.VERCEL) {
      throw httpError(503, "Définis la variable ACCESS_CODE dans Vercel (Settings > Environment Variables), puis redéploie.");
    }
    return;
  }
  const k = Array.isArray(req.query?.k) ? req.query.k[0] : req.query?.k;
  if (!sameToken(String(k || ""), TOKEN)) throw httpError(401, "Code d'accès requis");
}

const TIMEOUT_MS = 25000;
const MAX_DOCUMENT_SIZE = 8 * 1024 * 1024;
const MAX_RESOURCE_SIZE = 20 * 1024 * 1024;

const PRIVATE_IPV4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./, /^198\.1[89]\./, /^(22[4-9]|2[3-5]\d)\./
];

function isPrivateIPv4(ip) {
  return PRIVATE_IPV4.some((r) => r.test(ip));
}

function isPrivateIPv6(ip) {
  const v = String(ip || "").toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v)) return true;
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
}

async function checkPublicHost(hostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase();

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error("Adresse locale refusée");
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    if (isPrivateIPv4(host)) {
      throw new Error("Adresse privée refusée");
    }
    return;
  }

  if (host.includes(":") && isPrivateIPv6(host)) {
    throw new Error("Adresse privée refusée");
  }

  const addresses = await dns.lookup(host, {
    all: true,
    verbatim: true
  });

  if (!addresses.length) {
    throw new Error("Hôte introuvable");
  }

  for (const address of addresses) {
    if (
      address.family === 4 &&
      isPrivateIPv4(address.address)
    ) {
      throw new Error("Adresse privée refusée");
    }

    if (
      address.family === 6 &&
      isPrivateIPv6(address.address)
    ) {
      throw new Error("Adresse privée refusée");
    }
  }
}

function absoluteUrl(value, base) {
  try {
    const text = String(value || "").trim();

    if (!text) return null;

    if (
      /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(text)
    ) {
      return null;
    }

    return new URL(text, base).href;
  } catch {
    return null;
  }
}

function proxyUrl(origin, mode, target) {
  return (
    origin + "/api/proxy?mode=" + encodeURIComponent(mode) +
    "&url=" + encodeURIComponent(target) +
    (TOKEN ? "&k=" + TOKEN : "")
  );
}

function rewriteAttribute(
  html,
  tag,
  attribute,
  baseUrl,
  origin,
  mode = "resource"
) {
  const regex = new RegExp(
    "(<" +
      tag +
      "\\b[^>]*\\b" +
      attribute +
      "\\s*=\\s*)([\"'])(.*?)(\\2)",
    "gis"
  );

  return html.replace(
    regex,
    (match, prefix, quote, value) => {
      const target = absoluteUrl(value, baseUrl);

      if (!target) {
        return match;
      }

      return (
        prefix +
        quote +
        proxyUrl(origin, mode, target) +
        quote
      );
    }
  );
}

function rewriteSrcset(
  html,
  tag,
  baseUrl,
  origin
) {
  const regex = new RegExp(
    "(<" +
      tag +
      "\\b[^>]*\\bsrcset\\s*=\\s*)([\"'])(.*?)(\\2)",
    "gis"
  );

  return html.replace(
    regex,
    (match, prefix, quote, value) => {
      const rewritten = value
        .split(",")
        .map((entry) => {
          const parts = entry.trim().split(/\s+/);

          if (!parts[0]) {
            return entry;
          }

          const target = absoluteUrl(
            parts[0],
            baseUrl
          );

          if (!target) {
            return entry;
          }

          parts[0] = proxyUrl(
            origin,
            "resource",
            target
          );

          return parts.join(" ");
        })
        .join(", ");

      return (
        prefix +
        quote +
        rewritten +
        quote
      );
    }
  );
}

function rewriteCss(css, baseUrl, origin) {
  css = css.replace(/@import\s+(["'])(.*?)\1/gi, (m, q, v) => {
    const t = absoluteUrl(v, baseUrl);
    return t ? '@import "' + proxyUrl(origin, "resource", t) + '"' : m;
  });

  return css.replace(
    /url\(\s*(["']?)(.*?)\1\s*\)/gis,
    (match, quote, value) => {
      const target = absoluteUrl(
        value,
        baseUrl
      );

      if (!target) {
        return match;
      }

      return (
        'url("' +
        proxyUrl(
          origin,
          "resource",
          target
        ) +
        '")'
      );
    }
  );
}

function createBridge(origin) {
  const endpoint =
    origin + "/api/proxy";

  return `
<script>
(function () {
  const ENDPOINT = ${JSON.stringify(endpoint)};

  function ignored(url) {
    return /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i
      .test(String(url || ""));
  }

  function absolute(url) {
    try {
      return new URL(
        url,
        document.baseURI
      ).href;
    } catch {
      return null;
    }
  }

  function proxify(url, mode = "resource") {
    return (
      ENDPOINT +
      "?mode=" +
      encodeURIComponent(mode) +
      "&url=" +
      encodeURIComponent(url) +
      ${JSON.stringify(TOKEN ? "&k=" + TOKEN : "")}
    );
  }

  function navigate(url) {
    const target = absolute(url);

    if (!target) return;

    parent.postMessage(
      {
        type: "navigate",
        url: target
      },
      "*"
    );
  }

  document.addEventListener(
    "click",
    function (event) {
      const link =
        event.target &&
        event.target.closest
          ? event.target.closest("a[href]")
          : null;

      if (!link) return;

      const href =
        link.getAttribute("href");

      if (!href || ignored(href)) {
        return;
      }

      event.preventDefault();

      navigate(href);
    },
    true
  );

  document.addEventListener(
    "submit",
    function (event) {
      const form = event.target;

      if (!form) return;

      event.preventDefault();

      if (form.querySelector('input[type="password"]')) {
        parent.postMessage({ type: "blocked", reason: "Formulaire avec mot de passe bloqué" }, "*");
        return;
      }

      try {
        const target = new URL(
          form.getAttribute("action") ||
            document.baseURI,
          document.baseURI
        );

        const data = new FormData(form);

        for (const [key, value] of data.entries()) {
          if (typeof value === "string") {
            target.searchParams.append(
              key,
              value
            );
          }
        }

        navigate(target.href);
      } catch {}
    },
    true
  );

  const originalFetch = window.fetch;

  if (originalFetch) {
    window.fetch = function(input, init) {
      try {
        const sourceUrl =
          typeof input === "string"
            ? input
            : input && input.url;

        const target = absolute(sourceUrl);

        if (
          target &&
          /^https?:$/i.test(
            new URL(target).protocol
          )
        ) {
          const proxied = proxify(
            target,
            "resource"
          );

          if (typeof input === "string") {
            return originalFetch.call(
              this,
              proxied,
              init
            );
          }

          return originalFetch.call(
            this,
            new Request(
              proxied,
              input
            ),
            init
          );
        }
      } catch {}

      return originalFetch.call(
        this,
        input,
        init
      );
    };
  }

  const originalOpen =
    XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open =
    function(method, url) {
      try {
        const target = absolute(url);

        if (
          target &&
          /^https?:$/i.test(
            new URL(target).protocol
          )
        ) {
          url = proxify(
            target,
            "resource"
          );
        }
      } catch {}

      return originalOpen.apply(
        this,
        [
          method,
          url,
          ...Array.prototype.slice.call(
            arguments,
            2
          )
        ]
      );
    };

})();
</script>
`;
}

function rewriteHtml(
  html,
  baseUrl,
  origin
) {
  /*
   * IMPORTANT :
   * On retire les <base> existants.
   * On n'en ajoute PAS un nouveau.
   *
   * Cela évite le bug :
   * https://youtube.com/api/proxy
   * au lieu de :
   * https://emula-gold.vercel.app/api/proxy
   */
  html = html.replace(
    /<base\b[^>]*>/gi,
    ""
  );

  html = rewriteAttribute(
    html,
    "img",
    "src",
    baseUrl,
    origin
  );

  html = rewriteAttribute(
    html,
    "script",
    "src",
    baseUrl,
    origin
  );

  html = rewriteAttribute(
    html,
    "link",
    "href",
    baseUrl,
    origin
  );

  html = rewriteAttribute(
    html,
    "source",
    "src",
    baseUrl,
    origin
  );

  html = rewriteAttribute(
    html,
    "video",
    "src",
    baseUrl,
    origin
  );

  html = rewriteAttribute(
    html,
    "audio",
    "src",
    baseUrl,
    origin
  );

  html = rewriteAttribute(
    html,
    "embed",
    "src",
    baseUrl,
    origin
  );

  html = rewriteAttribute(
    html,
    "object",
    "data",
    baseUrl,
    origin
  );

  /*
   * Les iframes doivent passer par le proxy
   * pour éviter X-Frame-Options sur la cible.
   */
  html = rewriteAttribute(
    html,
    "iframe",
    "src",
    baseUrl,
    origin,
    "frame"
  );

  html = rewriteSrcset(
    html,
    "img",
    baseUrl,
    origin
  );

  html = rewriteSrcset(
    html,
    "source",
    baseUrl,
    origin
  );

  /*
   * CSS inline.
   */
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (match, open, css, close) => {
      return (
        open +
        rewriteCss(
          css,
          baseUrl,
          origin
        ) +
        close
      );
    }
  );

  /*
   * CSS dans style="..."
   */
  html = html.replace(
    /(\bstyle\s*=\s*)(["'])(.*?)(\2)/gis,
    (match, prefix, quote, value) => {
      return (
        prefix +
        quote +
        rewriteCss(
          value,
          baseUrl,
          origin
        ) +
        quote
      );
    }
  );

  /*
   * Supprime certaines protections HTML
   * présentes dans la page proxifiée.
   *
   * Cela ne garantit pas que le site acceptera
   * l'intégration, mais évite certains blocages
   * simples.
   */
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["']?\s*(?:content-security-policy|x-frame-options)\s*["']?[^>]*>/gi,
    ""
  );

  /*
   * Injecte le bridge AVANT </head>.
   */
  const bridge =
    createBridge(origin);

  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(
      /(<head\b[^>]*>)/i,
      "$1" + bridge
    );
  } else {
    html =
      bridge +
      html;
  }

  return html;
}

async function fetchLimited(url, headers, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let current = url;

    // Redirections suivies à la main : chaque étape est vérifiée
    for (let hop = 0; hop <= 5; hop++) {
      await checkPublicHost(new URL(current).hostname);

      const response = await fetch(current, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal
      });

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current);
        if (!["http:", "https:"].includes(next.protocol)) {
          throw new Error("Redirection refusée");
        }
        current = next.href;
        continue;
      }

      if (Number(response.headers.get("content-length") || 0) > maxBytes) {
        throw new Error("Ressource trop volumineuse");
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of response.body || []) {
        total += chunk.length;
        if (total > maxBytes) throw new Error("Ressource trop volumineuse");
        chunks.push(chunk);
      }

      return { response, buffer: Buffer.concat(chunks), finalUrl: current };
    }

    throw new Error("Trop de redirections");
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(
  req,
  res
) {
  /*
   * CORS / OPTIONS
   */
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "*"
    );

    return res.status(204).end();
  }

  try {
    if (String(req.query?.mode) === "auth") {
      if (!TOKEN) {
        checkAccess(req);
        return res.status(200).json({ needsCode: false });
      }
      if (req.query?.code !== undefined) {
        if (sameToken(tokenFor(String(req.query.code)), TOKEN)) {
          return res.status(200).json({ ok: true, k: TOKEN });
        }
        await new Promise((r) => setTimeout(r, 800));
        throw httpError(401, "Code incorrect");
      }
      return res.status(200).json({
        needsCode: true,
        valid: sameToken(String(req.query?.k || ""), TOKEN)
      });
    }

    checkAccess(req);

    const rawUrl =
      Array.isArray(req.query?.url)
        ? req.query.url[0]
        : req.query?.url;

    const mode =
      String(
        req.query?.mode ||
          "document"
      );

    if (!rawUrl) {
      return res.status(400).json({
        erreur:
          "Paramètre url manquant"
      });
    }

    if (
      ![
        "document",
        "frame",
        "resource"
      ].includes(mode)
    ) {
      return res.status(400).json({
        erreur:
          "Mode invalide"
      });
    }

    let target;

    try {
      target = new URL(rawUrl);
    } catch {
      return res.status(400).json({
        erreur:
          "URL invalide"
      });
    }

    if (
      !["http:", "https:"].includes(
        target.protocol
      )
    ) {
      return res.status(400).json({
        erreur:
          "Seuls HTTP et HTTPS sont autorisés"
      });
    }

    await checkPublicHost(
      target.hostname
    );

    const protocol =
      String(req.headers["x-forwarded-proto"] || (/^(localhost|127\.)/.test(String(req.headers["x-forwarded-host"] || req.headers.host || "")) ? "http" : "https"));

    const forwardedHost =
      String(
        req.headers["x-forwarded-host"] ||
          req.headers.host ||
          ""
      );

    const origin =
      forwardedHost
        ? protocol +
          "://" +
          forwardedHost
        : "";

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",

      "Accept-Language":
        "fr-FR,fr;q=0.9,en;q=0.8",

      "Accept":
        mode === "document" ||
        mode === "frame"
          ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
          : "*/*",

      "Referer":
        target.origin + "/"
    };

    const result =
      await fetchLimited(
        target.href,
        headers,
        mode === "document" ||
        mode === "frame"
          ? MAX_DOCUMENT_SIZE
          : MAX_RESOURCE_SIZE
      );

    const upstream =
      result.response;

    const buffer =
      result.buffer;

    const finalUrl =
      new URL(result.finalUrl);

    await checkPublicHost(
      finalUrl.hostname
    );

    const contentType =
      upstream.headers.get(
        "content-type"
      ) ||
      "application/octet-stream";

    /*
     * ==========================================
     * DOCUMENT / FRAME
     * ==========================================
     */

    if (
      mode === "document" ||
      mode === "frame"
    ) {
      if (
        !/html|xhtml/i.test(
          contentType
        )
      ) {
        return res.status(415).json({
          erreur:
            "La cible ne renvoie pas une page HTML",
          contentType
        });
      }

      const html =
        rewriteHtml(
          buffer.toString("utf8"),
          finalUrl.href,
          origin
        );

      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      /*
       * On ne renvoie PAS :
       * X-Frame-Options
       * CSP de la cible
       *
       * car ces en-têtes seraient ceux
       * du site distant, pas ceux d'Octavius.
       */

      if (mode === "frame") {
        res.setHeader(
          "Content-Type",
          "text/html; charset=utf-8"
        );

        return res
          .status(upstream.status)
          .send(html);
      }

      /*
       * Mode document :
       * renvoie du JSON au frontend.
       */
      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      return res
        .status(upstream.status)
        .json({
          statut:
            upstream.status,

          url:
            finalUrl.href,

          html
        });
    }

    /*
     * ==========================================
     * RESOURCE
     * ==========================================
     */

    let output = buffer;

    if (
      /text\/css/i.test(
        contentType
      )
    ) {
      output =
        Buffer.from(
          rewriteCss(
            buffer.toString("utf8"),
            finalUrl.href,
            origin
          ),
          "utf8"
        );
    }

    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Cache-Control",
      "public, max-age=300"
    );

    res.setHeader(
      "Content-Type",
      contentType.split(";")[0] ||
        "application/octet-stream"
    );

    res.setHeader(
      "X-Content-Type-Options",
      "nosniff"
    );

    return res
      .status(upstream.status)
      .send(output);

  } catch (error) {
    console.error(
      "Octavius proxy error:",
      error
    );

    const message =
      error?.name === "AbortError"
        ? "Le site a mis trop de temps à répondre."
        : String(
            error?.message ||
              error
          );

    return res.status(error?.status || 502).json({
      erreur: message
    });
  }
};
