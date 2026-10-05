// Vercel Serverless Function: /api/proxy
// Modes:
//   ?url=...&mode=document  -> JSON containing rewritten HTML
//   ?url=...&mode=resource  -> raw proxied resource (CSS, JS, image, font, ...)
//
// The emulator is designed for public websites. It deliberately blocks
// localhost/private-network targets to avoid turning the deployment into an SSRF proxy.

const MAX_DOCUMENT_BYTES = 1_600_000;
const MAX_RESOURCE_BYTES = 8_000_000;
const FETCH_TIMEOUT_MS = 12_000;

const PRIVATE_IPV4_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
];

function isPrivateIpv4(ip) {
  return PRIVATE_IPV4_RANGES.some((re) => re.test(ip));
}

function isPrivateIpv6(ip) {
  const value = String(ip || '').toLowerCase();
  return (
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.') ||
    value.startsWith('::ffff:172.16.')
  );
}

async function assertPublicHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Adresse locale refusée');
  }

  // Literal IP checks first.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    if (isPrivateIpv4(host)) throw new Error('Adresse réseau privée refusée');
    return;
  }
  if (host.includes(':') && isPrivateIpv6(host)) {
    throw new Error('Adresse réseau privée refusée');
  }

  // Resolve hostnames to prevent obvious DNS-rebinding/alias-to-private cases.
  const dns = require('node:dns').promises;
  const results = await dns.lookup(host, { all: true, verbatim: true });
  if (!results.length) throw new Error('Hôte introuvable');

  for (const item of results) {
    if (item.family === 4 && isPrivateIpv4(item.address)) {
      throw new Error('Adresse réseau privée refusée');
    }
    if (item.family === 6 && isPrivateIpv6(item.address)) {
      throw new Error('Adresse réseau privée refusée');
    }
  }
}

function absoluteUrl(raw, base) {
  try {
    const value = String(raw || '').trim();
    if (!value || value.startsWith('#')) return null;
    if (/^(data:|blob:|javascript:|mailto:|tel:|about:)/i.test(value)) return null;
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function proxyUrl(url, mode = 'resource') {
  return '/api/proxy?mode=' + encodeURIComponent(mode) + '&url=' + encodeURIComponent(url);
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rewriteAttribute(html, tagName, attrName, baseUrl) {
  const re = new RegExp(
    `(<${tagName}\\b[^>]*\\s${attrName}\\s*=\\s*)(["'])(.*?)(\\2)`,
    'gis'
  );
  return html.replace(re, (full, prefix, quote, value) => {
    const absolute = absoluteUrl(value, baseUrl);
    if (!absolute) return full;
    return prefix + quote + escapeAttr(proxyUrl(absolute, 'resource')) + quote;
  });
}

function rewriteSrcset(html, tagName, baseUrl) {
  const re = new RegExp(
    `(<${tagName}\\b[^>]*\\s(?:srcset|imagesrcset)\\s*=\\s*)(["'])(.*?)(\\2)`,
    'gis'
  );
  return html.replace(re, (full, prefix, quote, value) => {
    const rewritten = value.split(',').map((part) => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return part;
      const absolute = absoluteUrl(bits[0], baseUrl);
      if (!absolute) return part;
      bits[0] = proxyUrl(absolute, 'resource');
      return bits.join(' ');
    }).join(', ');
    return prefix + quote + escapeAttr(rewritten) + quote;
  });
}

function rewriteCssText(css, baseUrl) {
  return css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gis, (full, quote, raw) => {
    const absolute = absoluteUrl(raw, baseUrl);
    if (!absolute) return full;
    return `url("${proxyUrl(absolute, 'resource')}")`;
  });
}

function rewriteInlineStyles(html, baseUrl) {
  return html.replace(/(\bstyle\s*=\s*)(["'])(.*?)(\2)/gis, (full, prefix, quote, value) => {
    return prefix + quote + rewriteCssText(value, baseUrl).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + quote;
  });
}

function rewriteStyleBlocks(html, baseUrl) {
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gis, (full, open, css, close) => {
    return open + rewriteCssText(css, baseUrl) + close;
  });
}

const NAV_SCRIPT = `
<script>
(function () {
  function send(url, kind) {
    try { parent.postMessage({ type: kind || 'navigate', url: new URL(url, document.baseURI).href }, '*'); } catch (_) {}
  }

  document.addEventListener('click', function (event) {
    const a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^(javascript:|mailto:|tel:)/i.test(href)) return;
    event.preventDefault();
    send(href, 'navigate');
  }, true);

  document.addEventListener('submit', function (event) {
    const form = event.target;
    if (!form || String(form.method || 'get').toLowerCase() !== 'get') return;
    event.preventDefault();
    const action = new URL(form.getAttribute('action') || document.baseURI, document.baseURI);
    const data = new FormData(form);
    for (const [key, value] of data.entries()) {
      if (typeof value === 'string') action.searchParams.append(key, value);
    }
    send(action.href, 'navigate');
  }, true);

  // Basic resource shims for sites that use fetch/XMLHttpRequest for navigation.
  const realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      try {
        const target = typeof input === 'string' ? new URL(input, document.baseURI) : new URL(input.url, document.baseURI);
        if (/^https?:$/i.test(target.protocol)) {
          const proxied = '/api/proxy?mode=resource&url=' + encodeURIComponent(target.href);
          if (typeof input === 'string') return realFetch.call(this, proxied, init);
          return realFetch.call(this, new Request(proxied, input), init);
        }
      } catch (_) {}
      return realFetch.call(this, input, init);
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const target = new URL(url, document.baseURI);
      if (/^https?:$/i.test(target.protocol)) url = '/api/proxy?mode=resource&url=' + encodeURIComponent(target.href);
    } catch (_) {}
    return xhrOpen.apply(this, [method, url, ...Array.prototype.slice.call(arguments, 2)]);
  };
})();
</script>`;

async function fetchWithLimit(url, headers, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new Error('Ressource trop volumineuse');

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('Ressource trop volumineuse');
    return { response, buffer };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');

  try {
    const rawUrl = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url;
    const mode = String(req.query?.mode || 'document');
    if (!rawUrl) return res.status(400).json({ erreur: 'Paramètre url manquant' });
    if (!['document', 'resource'].includes(mode)) {
      return res.status(400).json({ erreur: 'Mode invalide' });
    }

    const requested = new URL(rawUrl);
    if (!['http:', 'https:'].includes(requested.protocol)) {
      return res.status(400).json({ erreur: 'Seules les adresses HTTP/HTTPS sont autorisées' });
    }
    await assertPublicHost(requested.hostname);

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36 Octavius-Emulator/2.0',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Accept': mode === 'document'
        ? 'text/html,application/xhtml+xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        : '*/*',
    };

    const { response, buffer } = await fetchWithLimit(requested.href, headers, mode === 'document' ? MAX_DOCUMENT_BYTES : MAX_RESOURCE_BYTES);
    const finalUrl = new URL(response.url);
    await assertPublicHost(finalUrl.hostname);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    if (mode === 'document') {
      if (!/html|xhtml/i.test(contentType)) {
        return res.status(415).json({ erreur: 'La cible ne renvoie pas une page HTML (' + contentType + ')' });
      }

      let html = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

      // Remove existing <base> and restrictive frame/CSP meta tags that commonly
      // make an emulated document unusable. The proxy itself remains sandboxed.
      html = html.replace(/<base\b[^>]*>/gi, '');
      html = html.replace(/<meta[^>]+http-equiv=["']?(?:content-security-policy|x-frame-options)["']?[^>]*>/gi, '');

      // Resource URLs become first-party proxy URLs, while normal links are handled
      // by NAV_SCRIPT so that browser history remains under emulator control.
      html = rewriteAttribute(html, 'img', 'src', finalUrl.href);
      html = rewriteAttribute(html, 'script', 'src', finalUrl.href);
      html = rewriteAttribute(html, 'link', 'href', finalUrl.href);
      html = rewriteAttribute(html, 'source', 'src', finalUrl.href);
      html = rewriteAttribute(html, 'video', 'src', finalUrl.href);
      html = rewriteAttribute(html, 'audio', 'src', finalUrl.href);
      html = rewriteAttribute(html, 'iframe', 'src', finalUrl.href);
      html = rewriteAttribute(html, 'embed', 'src', finalUrl.href);
      html = rewriteAttribute(html, 'object', 'data', finalUrl.href);
      html = rewriteSrcset(html, 'img', finalUrl.href);
      html = rewriteSrcset(html, 'source', finalUrl.href);
      html = rewriteInlineStyles(html, finalUrl.href);
      html = rewriteStyleBlocks(html, finalUrl.href);

      // Inline event handlers and inline scripts are intentionally preserved.
      // This makes dynamic sites much more useful than the previous "strip all JS" approach.
      const headClose = /<\/head>/i;
      const bootstrap = `<base href="${escapeAttr(finalUrl.href)}">`;
      html = headClose.test(html)
        ? html.replace(headClose, bootstrap + NAV_SCRIPT + '</head>')
        : bootstrap + NAV_SCRIPT + html;

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(response.status).json({
        statut: response.status,
        url: finalUrl.href,
        html,
      });
    }

    // Resource mode: return original bytes and content-type, with a light CSS URL rewrite.
    let payload = Buffer.from(buffer);
    if (/text\/css/i.test(contentType)) {
      const css = payload.toString('utf8');
      payload = Buffer.from(rewriteCssText(css, finalUrl.href), 'utf8');
    }

    res.setHeader('Content-Type', contentType.split(';')[0] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Never forward Set-Cookie from third-party sites into the emulator's own domain.
    return res.status(response.status).send(payload);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Le site a mis trop de temps à répondre.'
      : String(error?.message || error);
    return res.status(502).json({ erreur: message });
  }
};
