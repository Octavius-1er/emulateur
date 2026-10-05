"use strict";

const dns = require("node:dns").promises;

/* =========================================================
   CONFIGURATION
   ========================================================= */

const TIMEOUT_MS = 25000;

const MAX_DOCUMENT_SIZE = 8 * 1024 * 1024;
const MAX_RESOURCE_SIZE = 20 * 1024 * 1024;

/* =========================================================
   IP PRIVÉES
   ========================================================= */

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./
];

function isPrivateIPv4(ip) {
  return PRIVATE_IPV4.some((regex) => regex.test(ip));
}

function isPrivateIPv6(ip) {
  const value = String(ip || "").toLowerCase();

  return (
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("::ffff:127.") ||
    value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.")
  );
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

/* =========================================================
   CORS
   ========================================================= */

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (origin) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );

    res.setHeader(
      "Access-Control-Allow-Credentials",
      "true"
    );

    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );
  }

  const requestedHeaders =
    req.headers[
      "access-control-request-headers"
    ];

  res.setHeader(
    "Access-Control-Allow-Headers",
    requestedHeaders ||
      "Content-Type, Accept, Accept-Language, X-Requested-With"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, HEAD, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Type, Content-Length, Location, ETag, Accept-Ranges, Content-Range"
  );
}

/* =========================================================
   URLS
   ========================================================= */

function absoluteUrl(value, baseUrl) {
  try {
    const text = String(value || "").trim();

    if (!text) {
      return null;
    }

    if (
      /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(
        text
      )
    ) {
      return null;
    }

    return new URL(text, baseUrl).href;
  } catch {
    return null;
  }
}

function buildProxyUrl(origin, mode, target) {
  return (
    origin +
    "/api/proxy?mode=" +
    encodeURIComponent(mode) +
    "&url=" +
    encodeURIComponent(target)
  );
}

/* =========================================================
   ATTRIBUTS HTML
   ========================================================= */

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
      const target = absoluteUrl(
        value,
        baseUrl
      );

      if (!target) {
        return match;
      }

      return (
        prefix +
        quote +
        buildProxyUrl(
          origin,
          mode,
          target
        ) +
        quote
      );
    }
  );
}

/* =========================================================
   SRCSET
   ========================================================= */

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
    (
      match,
      prefix,
      quote,
      value
    ) => {
      const rewritten = value
        .split(",")
        .map((entry) => {
          const parts =
            entry.trim().split(/\s+/);

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

          parts[0] = buildProxyUrl(
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

/* =========================================================
   CSS
   ========================================================= */

function rewriteCss(
  css,
  baseUrl,
  origin
) {
  return css.replace(
    /url\(\s*(["']?)(.*?)\1\s*\)/gis,
    (
      match,
      quote,
      value
    ) => {
      const target = absoluteUrl(
        value,
        baseUrl
      );

      if (!target) {
        return match;
      }

      return (
        'url("' +
        buildProxyUrl(
          origin,
          "resource",
          target
        ) +
        '")'
      );
    }
  );
}

/* =========================================================
   BRIDGE JAVASCRIPT
   ========================================================= */

function createBridge(origin) {
  const endpoint =
    origin + "/api/proxy";

  return `
<script>
(function () {

  const ENDPOINT = ${JSON.stringify(endpoint)};
  const OCTAVIUS_ORIGIN = ${JSON.stringify(origin)};

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

  function isOwnProxy(url) {
    try {
      const target = new URL(
        url,
        document.baseURI
      );

      return (
        target.origin === OCTAVIUS_ORIGIN &&
        target.pathname === "/api/proxy"
      );
    } catch {
      return false;
    }
  }

  function proxify(
    url,
    mode = "resource"
  ) {
    return (
      ENDPOINT +
      "?mode=" +
      encodeURIComponent(mode) +
      "&url=" +
      encodeURIComponent(url)
    );
  }

  function navigate(url) {
    const target = absolute(url);

    if (!target) {
      return;
    }

    parent.postMessage(
      {
        type: "navigate",
        url: target
      },
      "*"
    );
  }

  /* -----------------------------------------------
     LIENS
     ----------------------------------------------- */

  document.addEventListener(
    "click",
    function (event) {
      const link =
        event.target &&
        event.target.closest
          ? event.target.closest("a[href]")
          : null;

      if (!link) {
        return;
      }

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

  /* -----------------------------------------------
     FORMULAIRES GET
     ----------------------------------------------- */

  document.addEventListener(
    "submit",
    function (event) {
      const form = event.target;

      if (!form) {
        return;
      }

      const method =
        String(
          form.method || "get"
        ).toLowerCase();

      if (method !== "get") {
        return;
      }

      event.preventDefault();

      try {
        const target =
          new URL(
            form.getAttribute("action") ||
              document.baseURI,
            document.baseURI
          );

        const data = new FormData(form);

        for (
          const [key, value]
          of data.entries()
        ) {
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

  /* -----------------------------------------------
     FETCH
     ----------------------------------------------- */

  const originalFetch =
    window.fetch;

  if (originalFetch) {
    window.fetch =
      function (input, init) {
        try {
          const sourceUrl =
            typeof input === "string"
              ? input
              : input && input.url;

          const target =
            absolute(sourceUrl);

          if (
            target &&
            !isOwnProxy(target) &&
            /^https?:$/i.test(
              new URL(target).protocol
            )
          ) {
            const proxied =
              proxify(
                target,
                "resource"
              );

            return originalFetch.call(
              this,
              proxied,
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

  /* -----------------------------------------------
     XMLHTTPREQUEST
     ----------------------------------------------- */

  const originalOpen =
    XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open =
    function (method, url) {
      try {
        const target =
          absolute(url);

        if (
          target &&
          !isOwnProxy(target) &&
          /^https?:$/i.test(
            new URL(target).protocol
          )
        ) {
          url =
            proxify(
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

  /* -----------------------------------------------
     WINDOW.OPEN
     ----------------------------------------------- */

  const originalWindowOpen =
    window.open;

  window.open =
    function (url) {
      if (
        typeof url === "string" &&
        url.trim()
      ) {
        navigate(url);
        return null;
      }

      return originalWindowOpen.apply(
        this,
        arguments
      );
    };

})();
</script>
`;
}

/* =========================================================
   GOOGLE SEARCH
   ========================================================= */

function isGoogleSearchPage(url) {
  try {
    const target = new URL(url);

    return (
      (
        target.hostname === "www.google.com" ||
        target.hostname === "google.com"
      ) &&
      target.pathname === "/search"
    );
  } catch {
    return false;
  }
}

/* =========================================================
   HTML
   ========================================================= */

function rewriteHtml(
  html,
  baseUrl,
  origin
) {
  /*
   * Supprime les anciens <base>.
   */
  html = html.replace(
    /<base\b[^>]*>/gi,
    ""
  );

  /*
   * Images.
   */
  html = rewriteAttribute(
    html,
    "img",
    "src",
    baseUrl,
    origin
  );

  /*
   * Scripts.
   */
  html = rewriteAttribute(
    html,
    "script",
    "src",
    baseUrl,
    origin
  );

  /*
   * CSS.
   */
  html = rewriteAttribute(
    html,
    "link",
    "href",
    baseUrl,
    origin
  );

  /*
   * Sources.
   */
  html = rewriteAttribute(
    html,
    "source",
    "src",
    baseUrl,
    origin
  );

  /*
   * Video / audio.
   */
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

  /*
   * Embed / object.
   */
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
   * IFRAME.
   */
  html = rewriteAttribute(
    html,
    "iframe",
    "src",
    baseUrl,
    origin,
    "frame"
  );

  /*
   * SRCSET.
   */
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
    (
      match,
      open,
      css,
      close
    ) => {
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
   * style="..."
   */
  html = html.replace(
    /(\bstyle\s*=\s*)(["'])(.*?)(\2)/gis,
    (
      match,
      prefix,
      quote,
      value
    ) => {
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
   * Supprime quelques métadonnées
   * susceptibles de bloquer l'affichage
   * dans le proxy.
   */
  html = html.replace(
    /<meta[^>]+http-equiv\s*=\s*["']?\s*(?:content-security-policy|x-frame-options|cross-origin-opener-policy|cross-origin-embedder-policy)\s*["']?[^>]*>/gi,
    ""
  );

  /*
   * IMPORTANT :
   * la base appartient au site distant.
   *
   * Cela permet à :
   *
   * /gen_204
   * /async/...
   * /xjs/...
   *
   * de rester liés au site chargé.
   */
  const baseTag =
    '<base href="' +
    baseUrl
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;") +
    '">';

  const bridge =
    createBridge(origin);

  if (
    /<head\b[^>]*>/i.test(html)
  ) {
    html = html.replace(
      /(<head\b[^>]*>)/i,
      "$1" +
      baseTag +
      bridge
    );
  } else {
    html =
      baseTag +
      bridge +
      html;
  }

  return html;
}

/* =========================================================
   BODY DES REQUÊTES
   ========================================================= */

async function readRequestBody(
  req,
  maxBytes
) {
  if (
    req.method === "GET" ||
    req.method === "HEAD"
  ) {
    return undefined;
  }

  /*
   * Vercel a parfois déjà parsé req.body.
   */

  if (
    req.body !== undefined &&
    req.body !== null
  ) {
    if (Buffer.isBuffer(req.body)) {
      return req.body;
    }

    if (typeof req.body === "string") {
      return Buffer.from(
        req.body
      );
    }

    if (
      typeof req.body === "object"
    ) {
      const contentType =
        String(
          req.headers["content-type"] ||
            ""
        ).toLowerCase();

      if (
        contentType.includes(
          "application/json"
        )
      ) {
        return Buffer.from(
          JSON.stringify(req.body)
        );
      }

      return Buffer.from(
        new URLSearchParams(
          req.body
        ).toString()
      );
    }
  }

  /*
   * Sinon, lecture brute du flux.
   */

  if (
    !req ||
    typeof req.on !== "function"
  ) {
    return undefined;
  }

  return new Promise(
    (resolve, reject) => {
      const chunks = [];
      let total = 0;

      req.on(
        "data",
        (chunk) => {
          const buffer =
            Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk);

          total += buffer.length;

          if (total > maxBytes) {
            reject(
              new Error(
                "Corps de requête trop volumineux"
              )
            );

            return;
          }

          chunks.push(buffer);
        }
      );

      req.on(
        "end",
        () => {
          resolve(
            Buffer.concat(chunks)
          );
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

/* =========================================================
   FETCH UPSTREAM
   ========================================================= */

async function fetchLimited(
  url,
  headers,
  maxBytes,
  method = "GET",
  body
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        url,
        {
          method,

          headers,

          body:
            method === "GET" ||
            method === "HEAD"
              ? undefined
              : body,

          redirect: "follow",

          signal:
            controller.signal
        }
      );

    const contentLength =
      Number(
        response.headers.get(
          "content-length"
        ) || 0
      );

    if (
      contentLength >
      maxBytes
    ) {
      throw new Error(
        "Ressource trop volumineuse"
      );
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (
      buffer.length >
      maxBytes
    ) {
      throw new Error(
        "Ressource trop volumineuse"
      );
    }

    return {
      response,
      buffer
    };
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   HANDLER VERCEL
   ========================================================= */

module.exports =
  async function handler(
    req,
    res
  ) {
    applyCors(
      req,
      res
    );

    /*
     * Preflight.
     */
    if (
      req.method === "OPTIONS"
    ) {
      return res
        .status(204)
        .end();
    }

    /*
     * Méthodes autorisées.
     */
    if (
      ![
        "GET",
        "POST",
        "HEAD"
      ].includes(req.method)
    ) {
      return res
        .status(405)
        .json({
          erreur:
            "Méthode non autorisée"
        });
    }

    try {
      /*
       * URL cible.
       */
      const rawUrl =
        Array.isArray(
          req.query?.url
        )
          ? req.query.url[0]
          : req.query?.url;

      const mode =
        String(
          req.query?.mode ||
            "document"
        );

      if (!rawUrl) {
        return res
          .status(400)
          .json({
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
        return res
          .status(400)
          .json({
            erreur:
              "Mode invalide"
          });
      }

      /*
       * Parse URL.
       */
      let target;

      try {
        target =
          new URL(rawUrl);
      } catch {
        return res
          .status(400)
          .json({
            erreur:
              "URL invalide"
          });
      }

      /*
       * HTTP(S) uniquement.
       */
      if (
        ![
          "http:",
          "https:"
        ].includes(
          target.protocol
        )
      ) {
        return res
          .status(400)
          .json({
            erreur:
              "Seuls HTTP et HTTPS sont autorisés"
          });
      }

      /*
       * Protection SSRF.
       */
      await checkPublicHost(
        target.hostname
      );

      /*
       * Origine Octavius.
       */
      const forwardedProto =
        String(
          req.headers[
            "x-forwarded-proto"
          ] ||
          "https"
        );

      const forwardedHost =
        String(
          req.headers[
            "x-forwarded-host"
          ] ||
          req.headers.host ||
          ""
        );

      const origin =
        forwardedHost
          ? forwardedProto +
            "://" +
            forwardedHost
          : "";

      /*
       * Headers envoyés
       * au site distant.
       *
       * On ne relaie pas directement
       * les cookies/identifiants du
       * navigateur vers une cible.
       */
      const upstreamHeaders = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",

        "Accept-Language":
          String(
            req.headers[
              "accept-language"
            ] ||
              "fr-FR,fr;q=0.9,en;q=0.8"
          ),

        "Accept":
          String(
            req.headers[
              "accept"
            ] ||
              (
                mode === "document" ||
                mode === "frame"
                  ? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
                  : "*/*"
              )
          ),

        "Referer":
          target.origin + "/"
      };

      /*
       * Content-Type des POST.
       */
      const contentType =
        req.headers[
          "content-type"
        ];

      if (contentType) {
        upstreamHeaders[
          "content-type"
        ] = contentType;
      }

      /*
       * Certains headers Google
       * peuvent être nécessaires.
       */
      for (
        const [key, value]
        of Object.entries(
          req.headers
        )
      ) {
        const lower =
          key.toLowerCase();

        if (
          lower.startsWith("x-goog-") ||
          lower === "x-client-data"
        ) {
          if (
            typeof value === "string"
          ) {
            upstreamHeaders[
              key
            ] = value;
          }
        }
      }

      /*
       * Body.
       */
      const requestBody =
        await readRequestBody(
          req,
          MAX_RESOURCE_SIZE
        );

      /*
       * Requête upstream.
       */
      const result =
        await fetchLimited(
          target.href,

          upstreamHeaders,

          (
            mode === "document" ||
            mode === "frame"
          )
            ? MAX_DOCUMENT_SIZE
            : MAX_RESOURCE_SIZE,

          req.method,

          requestBody
        );

      const upstream =
        result.response;

      const buffer =
        result.buffer;

      /*
       * URL finale.
       */
      const finalUrl =
        new URL(
          upstream.url
        );

      await checkPublicHost(
        finalUrl.hostname
      );

      const targetContentType =
        upstream.headers.get(
          "content-type"
        ) ||
        "application/octet-stream";

      /*
       * ==================================================
       * DOCUMENT / FRAME
       * ==================================================
       */

      if (
        mode === "document" ||
        mode === "frame"
      ) {
        if (
          !/html|xhtml/i.test(
            targetContentType
          )
        ) {
          return res
            .status(415)
            .json({
              erreur:
                "La cible ne renvoie pas du HTML",

              contentType:
                targetContentType
            });
        }

        const html =
          rewriteHtml(
            buffer.toString(
              "utf8"
            ),

            finalUrl.href,

            origin
          );

        res.setHeader(
          "Cache-Control",
          "no-store"
        );

        res.setHeader(
          "Content-Type",
          "text/html; charset=utf-8"
        );

        if (
          mode === "frame"
        ) {
          return res
            .status(
              upstream.status
            )
            .send(html);
        }

        return res
          .status(
            upstream.status
          )
          .json({
            statut:
              upstream.status,

            url:
              finalUrl.href,

            html
          });
      }

      /*
       * ==================================================
       * RESOURCE
       * ==================================================
       */

      let output =
        buffer;

      if (
        /text\/css/i.test(
          targetContentType
        )
      ) {
        output =
          Buffer.from(
            rewriteCss(
              buffer.toString(
                "utf8"
              ),

              finalUrl.href,

              origin
            ),
            "utf8"
          );
      }

      res.setHeader(
        "Cache-Control",
        "public, max-age=300"
      );

      res.setHeader(
        "Content-Type",
        targetContentType.split(
          ";"
        )[0] ||
          "application/octet-stream"
      );

      res.setHeader(
        "X-Content-Type-Options",
        "nosniff"
      );

      res.setHeader(
        "Cross-Origin-Resource-Policy",
        "cross-origin"
      );

      if (
        req.method === "HEAD"
      ) {
        return res
          .status(
            upstream.status
          )
          .end();
      }

      return res
        .status(
          upstream.status
        )
        .send(output);

    } catch (error) {
      console.error(
        "Octavius proxy error:",
        error
      );

      const message =
        error?.name ===
        "AbortError"
          ? "Le site a mis trop de temps à répondre."
          : String(
              error?.message ||
                error
            );

      return res
        .status(502)
        .json({
          erreur:
            message
        });
    }
  };
