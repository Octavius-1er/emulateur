const dns = require("dns").promises;

const MAX_BODY_SIZE = 25 * 1024 * 1024;

const BLOCKED_RESPONSE_HEADERS = new Set([
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "frame-options",
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "cross-origin-resource-policy",
    "origin-agent-cluster"
]);

function isPrivateIPv4(ip) {
    const parts = ip.split(".").map(Number);

    if (parts.length !== 4 || parts.some(Number.isNaN)) {
        return true;
    }

    const [a, b] = parts;

    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;

    if (a === 169 && b === 254) return true;

    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    }

    if (a === 192 && b === 168) {
        return true;
    }

    return false;
}

function isPrivateIPv6(ip) {
    const value = ip.toLowerCase();

    if (value === "::1") return true;
    if (value === "::") return true;

    if (
        value.startsWith("fc") ||
        value.startsWith("fd") ||
        value.startsWith("fe80:")
    ) {
        return true;
    }

    return false;
}

async function checkPublicHost(hostname) {
    const host = hostname.toLowerCase();

    if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal")
    ) {
        throw new Error("Host interdit");
    }

    const records = await dns.lookup(host, {
        all: true,
        verbatim: true
    });

    if (!records.length) {
        throw new Error("DNS introuvable");
    }

    for (const record of records) {
        if (record.family === 4 && isPrivateIPv4(record.address)) {
            throw new Error("Adresse privée interdite");
        }

        if (record.family === 6 && isPrivateIPv6(record.address)) {
            throw new Error("Adresse IPv6 privée interdite");
        }
    }
}

function applyCors(req, res) {
    const origin = req.headers.origin;

    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With, Accept, Origin"
    );

    res.setHeader("Access-Control-Allow-Credentials", "true");

    res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Type, Content-Length, Location, Set-Cookie"
    );
}

function absoluteUrl(value, base) {
    try {
        return new URL(value, base).href;
    } catch {
        return null;
    }
}

function buildProxyUrl(targetUrl, mode = "resource") {
    return (
        "/api/proxy?mode=" +
        encodeURIComponent(mode) +
        "&url=" +
        encodeURIComponent(targetUrl)
    );
}

function rewriteAttribute(value, baseUrl, mode = "resource") {
    if (!value) return value;

    const trimmed = value.trim();

    if (
        !trimmed ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("data:") ||
        trimmed.startsWith("blob:") ||
        trimmed.startsWith("javascript:") ||
        trimmed.startsWith("mailto:") ||
        trimmed.startsWith("tel:")
    ) {
        return value;
    }

    const absolute = absoluteUrl(trimmed, baseUrl);

    if (!absolute) {
        return value;
    }

    return buildProxyUrl(absolute, mode);
}

function rewriteSrcset(value, baseUrl) {
    if (!value) return value;

    return value
        .split(",")
        .map((item) => {
            const part = item.trim();

            if (!part) return part;

            const pieces = part.split(/\s+/);
            const url = pieces.shift();

            const rewritten = rewriteAttribute(
                url,
                baseUrl,
                "resource"
            );

            return [rewritten, ...pieces].join(" ");
        })
        .join(", ");
}

function rewriteCss(css, baseUrl) {
    if (!css) return css;

    return css.replace(
        /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
        (full, quote, value) => {
            const trimmed = value.trim();

            if (
                !trimmed ||
                trimmed.startsWith("data:") ||
                trimmed.startsWith("blob:") ||
                trimmed.startsWith("#")
            ) {
                return full;
            }

            const absolute = absoluteUrl(trimmed, baseUrl);

            if (!absolute) {
                return full;
            }

            return `url("${buildProxyUrl(absolute, "resource")}")`;
        }
    );
}

function createBridge() {
    return `
<script>
(function() {
    const PROXY_PATH = "/api/proxy";

    function isAbsoluteHttp(url) {
        return /^https?:\\\\/\\\\//i.test(url || "");
    }

    function proxyUrl(url, mode) {
        try {
            const absolute = new URL(url, document.baseURI);

            if (
                location.origin === absolute.origin &&
                absolute.pathname === PROXY_PATH
            ) {
                return absolute.href;
            }

            return (
                PROXY_PATH +
                "?mode=" +
                encodeURIComponent(mode || "frame") +
                "&url=" +
                encodeURIComponent(absolute.href)
            );
        } catch {
            return url;
        }
    }

    function navigate(url) {
        const target = new URL(url, document.baseURI).href;

        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage(
                    {
                        type: "octavius:navigate",
                        url: target
                    },
                    "*"
                );

                return;
            }
        } catch {}

        location.href = proxyUrl(target, "frame");
    }

    document.addEventListener(
        "click",
        function(event) {
            const link = event.target.closest
                ? event.target.closest("a[href]")
                : null;

            if (!link) return;
            if (event.defaultPrevented) return;
            if (event.button !== 0) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
            }

            const href = link.getAttribute("href");

            if (!href) return;
            if (
                href.startsWith("#") ||
                href.startsWith("javascript:") ||
                href.startsWith("mailto:") ||
                href.startsWith("tel:")
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            navigate(new URL(href, document.baseURI).href);
        },
        true
    );

    document.addEventListener(
        "submit",
        function(event) {
            const form = event.target;

            if (!(form instanceof HTMLFormElement)) {
                return;
            }

            const method = (form.method || "GET").toUpperCase();

            if (method !== "GET") {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const action = new URL(
                form.getAttribute("action") || location.href,
                document.baseURI
            );

            const data = new FormData(form);

            for (const [key, value] of data.entries()) {
                action.searchParams.set(key, value);
            }

            navigate(action.href);
        },
        true
    );

    const originalFetch = window.fetch;

    if (originalFetch) {
        window.fetch = function(input, init) {
            try {
                let url;

                if (typeof input === "string") {
                    url = input;
                } else if (input && input.url) {
                    url = input.url;
                }

                if (url && isAbsoluteHttp(url)) {
                    const target = new URL(url, document.baseURI);

                    if (
                        !(target.origin === location.origin &&
                          target.pathname === PROXY_PATH)
                    ) {
                        if (input instanceof Request) {
                            input = new Request(
                                proxyUrl(target.href, "resource"),
                                input
                            );
                        } else {
                            input = proxyUrl(target.href, "resource");
                        }
                    }
                }
            } catch {}

            return originalFetch.call(this, input, init);
        };
    }

    const originalOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function(
        method,
        url,
        async,
        user,
        password
    ) {
        try {
            if (typeof url === "string" && isAbsoluteHttp(url)) {
                const target = new URL(url, document.baseURI);

                if (
                    !(
                        target.origin === location.origin &&
                        target.pathname === PROXY_PATH
                    )
                ) {
                    url = proxyUrl(target.href, "resource");
                }
            }
        } catch {}

        return originalOpen.call(
            this,
            method,
            url,
            async,
            user,
            password
        );
    };

    const originalWindowOpen = window.open;

    window.open = function(url, target, features) {
        if (url) {
            navigate(new URL(url, document.baseURI).href);
            return null;
        }

        return originalWindowOpen.call(
            window,
            url,
            target,
            features
        );
    };
})();
</script>
`;
}

function rewriteHtml(html, baseUrl) {
    let output = html;

    output = output.replace(
        /<base\\b[^>]*>/gi,
        ""
    );

    output = output.replace(
        /<meta\\b[^>]*(?:http-equiv\\s*=\\s*["']?(?:content-security-policy|x-frame-options|content-security-policy-report-only|referrer-policy)["']?)[^>]*>/gi,
        ""
    );

    output = output.replace(
        /(<html\\b[^>]*)(>)/i,
        `$1$2`
    );

    output = output.replace(
        /<head\\b[^>]*>/i,
        (match) => {
            return (
                match +
                `<base href="${escapeHtmlAttribute(baseUrl)}">` +
                createBridge()
            );
        }
    );

    output = output.replace(
        /\\s(?:src|href|poster)\\s*=\\s*(["'])(.*?)\\1/gi,
        (full, quote, value) => {
            const attrNameMatch = full.match(
                /\\s(src|href|poster)\\s*=/i
            );

            const attrName = attrNameMatch
                ? attrNameMatch[1].toLowerCase()
                : "src";

            let mode = "resource";

            if (attrName === "href") {
                mode = "resource";
            }

            const rewritten = rewriteAttribute(
                value,
                baseUrl,
                mode
            );

            return full.replace(
                value,
                rewritten
            );
        }
    );

    output = output.replace(
        /\\s(?:srcset)\\s*=\\s*(["'])(.*?)\\1/gi,
        (full, quote, value) => {
            return full.replace(
                value,
                rewriteSrcset(value, baseUrl)
            );
        }
    );

    output = output.replace(
        /(<style\\b[^>]*>)([\\s\\S]*?)(<\\/style>)/gi,
        (full, open, css, close) => {
            return (
                open +
                rewriteCss(css, baseUrl) +
                close
            );
        }
    );

    output = output.replace(
        /\\sstyle\\s*=\\s*(["'])(.*?)\\1/gi,
        (full, quote, css) => {
            return full.replace(
                css,
                rewriteCss(css, baseUrl)
            );
        }
    );

    output = output.replace(
        /(<link\\b[^>]*rel\\s*=\\s*["'][^"']*stylesheet[^"']*["'][^>]*>)/gi,
        (full) => {
            return full.replace(
                /(href\\s*=\\s*)(["'])(.*?)\\2/i,
                (m, prefix, quote, value) => {
                    const rewritten = rewriteAttribute(
                        value,
                        baseUrl,
                        "resource"
                    );

                    return prefix + quote + rewritten + quote;
                }
            );
        }
    );

    return output;
}

function escapeHtmlAttribute(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

async function readRequestBody(req) {
    if (req.body !== undefined && req.body !== null) {
        if (Buffer.isBuffer(req.body)) {
            return req.body;
        }

        if (typeof req.body === "string") {
            return Buffer.from(req.body);
        }

        if (typeof req.body === "object") {
            return Buffer.from(JSON.stringify(req.body));
        }
    }

    if (!req.readable) {
        return null;
    }

    const chunks = [];
    let size = 0;

    for await (const chunk of req) {
        size += chunk.length;

        if (size > MAX_BODY_SIZE) {
            throw new Error("Corps de requête trop volumineux");
        }

        chunks.push(chunk);
    }

    return chunks.length
        ? Buffer.concat(chunks)
        : null;
}

async function fetchLimited(url, options) {
    const response = await fetch(url, {
        ...options,
        redirect: "follow"
    });

    return response;
}

module.exports = async function handler(req, res) {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return res.end();
    }

    try {
        const rawUrl =
            typeof req.query?.url === "string"
                ? req.query.url
                : null;

        const mode =
            typeof req.query?.mode === "string"
                ? req.query.mode
                : "resource";

        if (!rawUrl) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");

            return res.end(
                JSON.stringify({
                    error: "URL manquante"
                })
            );
        }

        let target;

        try {
            target = new URL(rawUrl);
        } catch {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");

            return res.end(
                JSON.stringify({
                    error: "URL invalide"
                })
            );
        }

        if (!["http:", "https:"].includes(target.protocol)) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");

            return res.end(
                JSON.stringify({
                    error: "Protocole interdit"
                })
            );
        }

        await checkPublicHost(target.hostname);

        const body =
            ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
                ? await readRequestBody(req)
                : undefined;

        const headers = {};

        const forwardHeaders = [
            "accept",
            "accept-language",
            "content-type",
            "user-agent",
            "referer",
            "origin"
        ];

        for (const name of forwardHeaders) {
            const value = req.headers[name];

            if (value) {
                headers[name] = value;
            }
        }

        delete headers.host;
        delete headers.connection;
        delete headers["content-length"];

        const upstream = await fetchLimited(
            target.href,
            {
                method: req.method,
                headers,
                body
            }
        );

        let contentType =
            upstream.headers.get("content-type") ||
            "application/octet-stream";

        let responseBody;

        if (mode === "frame" || mode === "document") {
            if (contentType.includes("text/html")) {
                const text = await upstream.text();

                responseBody = rewriteHtml(
                    text,
                    target.href
                );

                contentType =
                    "text/html; charset=utf-8";
            } else {
                const buffer =
                    Buffer.from(
                        await upstream.arrayBuffer()
                    );

                responseBody = buffer;
            }
        } else if (contentType.includes("text/css")) {
            const text = await upstream.text();

            responseBody = rewriteCss(
                text,
                target.href
            );

            contentType =
                "text/css; charset=utf-8";
        } else {
            responseBody =
                Buffer.from(
                    await upstream.arrayBuffer()
                );
        }

        res.statusCode = upstream.status;

        for (const [key, value] of upstream.headers.entries()) {
            const lower = key.toLowerCase();

            if (BLOCKED_RESPONSE_HEADERS.has(lower)) {
                continue;
            }

            if (
                lower === "content-length" ||
                lower === "transfer-encoding" ||
                lower === "content-encoding"
            ) {
                continue;
            }

            if (lower === "set-cookie") {
                continue;
            }

            if (lower === "location") {
                const absolute = absoluteUrl(
                    value,
                    target.href
                );

                if (absolute) {
                    res.setHeader(
                        "Location",
                        buildProxyUrl(absolute, "frame")
                    );
                }

                continue;
            }

            try {
                res.setHeader(key, value);
            } catch {}
        }

        res.setHeader(
            "Content-Type",
            contentType
        );

        res.setHeader(
            "Cache-Control",
            "no-store"
        );

        res.setHeader(
            "X-Content-Type-Options",
            "nosniff"
        );

        res.removeHeader("X-Frame-Options");
        res.removeHeader("Content-Security-Policy");
        res.removeHeader("Content-Security-Policy-Report-Only");

        if (Buffer.isBuffer(responseBody)) {
            return res.end(responseBody);
        }

        return res.end(responseBody);
    } catch (error) {
        console.error(error);

        res.statusCode = 502;

        res.setHeader(
            "Content-Type",
            "application/json; charset=utf-8"
        );

        return res.end(
            JSON.stringify({
                error: "Proxy error",
                message:
                    error?.message ||
                    "Erreur inconnue"
            })
        );
    }
};
