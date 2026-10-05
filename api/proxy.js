// Vercel Serverless Function: /api/proxy
// Modes:
//   ?url=...&mode=document  -> JSON containing rewritten HTML
//   ?url=...&mode=resource  -> raw proxied resource (CSS, JS, image, font, ...)
//
// The emulator is designed for public websites. It deliberately blocks
// localhost/private-network targets to avoid turning the deployment into an SSRF proxy.

const MAX_DOCUMENT_BYTES = 4_000_000;
const MAX_RESOURCE_BYTES = 8_000_000;
const FETCH_TIMEOUT_MS = 20_000;

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

function proxyUrl(url, mode = 'resource', proxyOrigin = '') {
  const prefix = proxyOrigin || '';
  return prefix + '/api/proxy?mode=' + encodeURIComponent(mode) + '&url=' + encodeURIComponent(url);
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rewriteAttribute(html, tagName, attrName, baseUrl, proxyOrigin, mode = 'resource') {
  const re = new RegExp(
    `(<${tagName}\\b[^>]*\\s${attrName}\\s*=\\s*)(["'])(.*?)(\\2)`,
    'gis'
  );
  return html.replace(re, (full, prefix, quote, value) => {
    const absolute = absoluteUrl(value, baseUrl);
    if (!absolute) return full;
    return prefix + quote + escapeAttr(proxyUrl(absolute, mode, proxyOrigin)) + quote;
  });
}

function rewriteSrcset(html, tagName, baseUrl, proxyOrigin) {
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
      bits[0] = proxyUrl(absolute, 'resource', proxyOrigin);
      return bits.join(' ');
    }).join(', ');
    return prefix + quote + escapeAttr(rewritten) + quote;
  });
}

function rewriteCssText(css, baseUrl, proxyOrigin) {
  return css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gis, (full, quote, raw) => {
    const absolute = absoluteUrl(raw, baseUrl);
    if (!absolute) return full;
    return `url("${proxyUrl(absolute, 'resource', proxyOrigin)}")`;
  });
}

function rewriteInlineStyles(html, baseUrl, proxyOrigin) {
  return html.replace(/(\bstyle\s*=\s*)(["'])(.*?)(\2)/gis, (full, prefix, quote, value) => {
    return prefix + quote + rewriteCssText(value, baseUrl, proxyOrigin).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + quote;
  });
}

function rewriteStyleBlocks(html, baseUrl, proxyOrigin) {
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gis, (full, open, css, close) => {
    return open + rewriteCssText(css, baseUrl, proxyOrigin) + close;
  });
}

const NAV_SCRIPT = (proxyEndpoint) => `
<script>
(function () {
  const PROXY_ENDPOINT = ${JSON.stringify('PROXY_ENDPOINT_PLACEHOLDER')}.replace('PROXY_ENDPOINT_PLACEHOLDER', proxyEndpoint);
  const PROXY = (url, mode) => PROXY_ENDPOINT + '?mode=' + encodeURIComponent(mode || 'resource') + '&url=' + encodeURIComponent(url);

  function send(url, kind) {
    try { parent.postMessage({ type: kind || 'navigate', url: new URL(url, document.baseURI).href }, '*'); } catch (_) {}
  }

  function shouldLeaveAlone(url) {
    return /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(String(url || ''));
  }

  // Keep regular navigation inside Octavius instead of escaping to the real site.
  document.addEventListener('click', function (event) {
    const a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || shouldLeaveAlone(href)) return;
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

  // Proxy fetch/XHR to the Octavius origin. The proxy URL MUST be absolute because
  // the page has a <base> pointing at the original site.
  const realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      try {
        const target = typeof input === 'string' ? new URL(input, document.baseURI) : new URL(input.url, document.baseURI);
        if (/^https?:$/i.test(target.protocol)) {
          const proxied = PROXY(target.href, 'resource');
          if (typeof input === 'string') return realFetch.call(this, proxied, init);
          const request = new Request(proxied, input);
          return realFetch.call(this, request, init);
        }
      } catch (_) {}
      return realFetch.call(this, input, init);
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const target = new URL(url, document.baseURI);
      if (/^https?:$/i.test(target.protocol)) url = PROXY(target.href, 'resource');
    } catch (_) {}
    return xhrOpen.apply(this, [method, url, ...Array.prototype.slice.call(arguments, 2)]);
  };

  // Rewrite dynamically-created iframes before they can navigate to a site that
  // refuses framing with X-Frame-Options.
  function rewriteFrame(frame) {
    try {
      const src = frame.getAttribute('src');
      if (!src || shouldLeaveAlone(src) || src.startsWith(PROXY_ENDPOINT)) return;
      const absolute = new URL(src, document.baseURI).href;
      if (/^https?:$/i.test(new URL(absolute).protocol)) {
        frame.setAttribute('src', PROXY(absolute, 'frame'));
      }
    } catch (_) {}
  }

  document.querySelectorAll('iframe[src]').forEach(rewriteFrame);
  const observer = new MutationObserver(function (mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof Element)) continue;
        if (node.matches && node.matches('iframe[src]')) rewriteFrame(node);
        node.querySelectorAll?.('iframe[src]').forEach(rewriteFrame);
      }
      if (mutation.type === 'attributes' && mutation.target instanceof HTMLIFrameElement) rewriteFrame(mutation.target);
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
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
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    return res.status(204).end();
  }
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');

  try {
    const rawUrl = Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url;
    const mode = String(req.query?.mode || 'document');
    const forwardedProto = String(req.headers['x-forwarded-proto'] || 'https');
    const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    const proxyOrigin = forwardedHost ? `${forwardedProto}://${forwardedHost}` : '';
    const proxyEndpoint = `${proxyOrigin}/api/proxy`;
    if (!rawUrl) return res.status(400).json({ erreur: 'Paramètre url manquant' });
    if (!['document', 'resource', 'frame'].includes(mode)) {
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

    if (mode === 'document' || mode === 'frame') {
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
      html = rewriteAttribute(html, 'img', 'src', finalUrl.href, proxyOrigin);
      html = rewriteAttribute(html, 'script', 'src', finalUrl.href, proxyOrigin);
      html = rewriteAttribute(html, 'link', 'href', finalUrl.href, proxyOrigin);
      html = rewriteAttribute(html, 'source', 'src', finalUrl.href, proxyOrigin);
      html = rewriteAttribute(html, 'video', 'src', finalUrl.href, proxyOrigin);
      html = rewriteAttribute(html, 'audio', 'src', finalUrl.href, proxyOrigin);
      html = rewriteAttribute(html, 'iframe', 'src', finalUrl.href, proxyOrigin, 'frame');
      html = rewriteAttribute(html, 'embed', 'src', finalUrl.href, proxyOrigin);
      html = rewriteAttribute(html, 'object', 'data', finalUrl.href, proxyOrigin);
      html = rewriteSrcset(html, 'img', finalUrl.href, proxyOrigin);
      html = rewriteSrcset(html, 'source', finalUrl.href, proxyOrigin);
      html = rewriteInlineStyles(html, finalUrl.href, proxyOrigin);
      html = rewriteStyleBlocks(html, finalUrl.href, proxyOrigin);

      // Inline event handlers and inline scripts are intentionally preserved.
      // This makes dynamic sites much more useful than the previous "strip all JS" approach.
      const headClose = /<\/head>/i;
      const bootstrap = `<base href="${escapeAttr(finalUrl.href)}">`;
      const injected = NAV_SCRIPT(proxyEndpoint);
      html = headClose.test(html)
        ? html.replace(headClose, bootstrap + injected + '</head>')
        : bootstrap + injected + html;

      if (mode === 'frame') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(response.status).send(html);
      }

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
      payload = Buffer.from(rewriteCssText(css, finalUrl.href, proxyOrigin), 'utf8');
    }

    res.setHeader('Content-Type', contentType.split(';')[0] || 'application/octet-stream');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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
