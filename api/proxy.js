const dns = require("dns").promises;

const BLOCKED_HEADERS = new Set([
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "cross-origin-resource-policy"
]);

function setCors(req, res) {
    const origin = req.headers?.origin;

    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }

    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );

    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With, Accept, Origin"
    );

    res.setHeader(
        "Access-Control-Allow-Credentials",
        "true"
    );
}

function isPrivateIPv4(ip) {
    const p = ip.split(".").map(Number);

    if (p.length !== 4 || p.some(Number.isNaN)) {
        return true;
    }

    const [a, b] = p;

    return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

function isPrivateIPv6(ip) {
    const x = String(ip).toLowerCase();

    return (
        x === "::" ||
        x === "::1" ||
        x.startsWith("fc") ||
        x.startsWith("fd") ||
        x.startsWith("fe80:")
    );
}

async function checkHost(hostname) {
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
        all: true
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

function absoluteUrl(value, base) {
    try {
        return new URL(value, base).href;
    } catch {
        return null;
    }
}

function proxyUrl(target, mode = "resource") {
    return (
        "/api/proxy?mode=" +
        encodeURIComponent(mode) +
        "&url=" +
        encodeURIComponent(target)
    );
}

function rewriteUrl(value, base, mode = "resource") {
    if (!value) {
        return value;
    }

    const v = value.trim();

    if (
        v.startsWith("#") ||
        v.startsWith("data:") ||
        v.startsWith("blob:") ||
        v.startsWith("javascript:") ||
        v.startsWith("mailto:") ||
        v.startsWith("tel:")
    ) {
        return value;
    }

    const absolute = absoluteUrl(v, base);

    if (!absolute) {
        return value;
    }

    return proxyUrl(absolute, mode);
}

function rewriteSrcset(value, base) {
    return value
        .split(",")
        .map((part) => {
            const pieces = part.trim().split(/\s+/);

            if (!pieces[0]) {
                return part;
            }

            pieces[0] = rewriteUrl(
                pieces[0],
                base,
                "resource"
            );

            return pieces.join(" ");
        })
        .join(", ");
}

function rewriteCss(css, base) {
    return css.replace(
        /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
        (full, quote, value) => {
            const v = value.trim();

            if (
                !v ||
                v.startsWith("data:") ||
                v.startsWith("blob:") ||
                v.startsWith("#")
            ) {
                return full;
            }

            const absolute = absoluteUrl(v, base);

            if (!absolute) {
                return full;
            }

            return `url("${proxyUrl(
                absolute,
                "resource"
            )}")`;
        }
    );
}

function bridgeScript() {
    return `
<script>
(function () {
    const PROXY = "/api/proxy";

    function isOwnProxy(url) {
        try {
            const u = new URL(url, document.baseURI);
            return (
                u.origin === location.origin &&
                u.pathname === PROXY
            );
        } catch {
            return false;
        }
    }

    function navigate(url) {
        try {
            const target = new URL(
                url,
                document.baseURI
            ).href;

            if (
                window.parent &&
                window.parent !== window
            ) {
                window.parent.postMessage(
                    {
                        type: "octavius:navigate",
                        url: target
                    },
                    "*"
                );

                return;
            }

            location.href =
                PROXY +
                "?mode=frame&url=" +
                encodeURIComponent(target);

        } catch {}
    }

    document.addEventListener(
        "click",
        function (event) {
            const link =
                event.target.closest
                    ? event.target.closest("a[href]")
                    : null;

            if (!link) return;
            if (event.defaultPrevented) return;
            if (event.button !== 0) return;

            if (
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
            ) {
                return;
            }

            const href =
                link.getAttribute("href");

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

            navigate(
                new URL(
                    href,
                    document.baseURI
                ).href
            );
        },
        true
    );

    document.addEventListener(
        "submit",
        function (event) {
            const form = event.target;

            if (!(form instanceof HTMLFormElement)) {
                return;
            }

            const method =
                (form.method || "GET").toUpperCase();

            if (method !== "GET") {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            const target = new URL(
                form.getAttribute("action") ||
                location.href,
                document.baseURI
            );

            const data = new FormData(form);

            for (const [key, value] of data.entries()) {
                target.searchParams.set(
                    key,
                    value
                );
            }

            navigate(target.href);
        },
        true
    );

    const oldFetch = window.fetch;

    if (oldFetch) {
        window.fetch = function (input, init) {
            try {
                let url = null;

                if (typeof input === "string") {
                    url = input;
                } else if (input && input.url) {
                    url = input.url;
                }

                if (url && /^https?:\\/\\//i.test(url)) {
                    if (!isOwnProxy(url)) {
                        const target =
                            new URL(
                                url,
                                document.baseURI
                            );

                        if (
                            input instanceof Request
                        ) {
                            input = new Request(
                                PROXY +
                                "?mode=resource&url=" +
                                encodeURIComponent(
                                    target.href
                                ),
                                input
                            );
                        } else {
                            input =
                                PROXY +
                                "?mode=resource&url=" +
                                encodeURIComponent(
                                    target.href
                                );
                        }
                    }
                }
            } catch {}

            return oldFetch.call(
                this,
                input,
                init
            );
        };
    }

    const oldOpen =
        XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open =
        function (
            method,
            url,
            async,
            user,
            password
        ) {
            try {
                if (
                    typeof url === "string" &&
                    /^https?:\\/\\//i.test(url) &&
                    !isOwnProxy(url)
                ) {
                    const target =
                        new URL(
                            url,
                            document.baseURI
                        );

                    url =
                        PROXY +
                        "?mode=resource&url=" +
                        encodeURIComponent(
                            target.href
                        );
                }
            } catch {}

            return oldOpen.call(
                this,
                method,
                url,
                async,
                user,
                password
            );
        };

    const oldWindowOpen = window.open;

    window.open = function (
        url,
        target,
        features
    ) {
        if (url) {
            navigate(url);
            return null;
        }

        return oldWindowOpen.call(
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

function escapeAttr(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function rewriteHtml(html, baseUrl) {
    let output = html;

    output = output.replace(
        /<base\\b[^>]*>/gi,
        ""
    );

    output = output.replace(
        /<meta\\b[^>]*http-equiv\\s*=\\s*["']?(?:content-security-policy|content-security-policy-report-only|x-frame-options)[^>]*>/gi,
        ""
    );

    const baseTag =
        `<base href="${escapeAttr(baseUrl)}">`;

    output = output.replace(
        /<head\\b[^>]*>/i,
        (match) => {
            return (
                match +
                baseTag +
                bridgeScript()
            );
        }
    );

    output = output.replace(
        /\\s(src|href|poster)\\s*=\\s*(["'])(.*?)\\2/gi,
        (full, name, quote, value) => {
            const rewritten =
                rewriteUrl(
                    value,
                    baseUrl,
                    "resource"
                );

            return (
                " " +
                name +
                "=" +
                quote +
                rewritten +
                quote
            );
        }
    );

    output = output.replace(
        /\\ssrcset\\s*=\\s*(["'])(.*?)\\1/gi,
        (full, quote, value) => {
            return (
                " srcset=" +
                quote +
                rewriteSrcset(
                    value,
                    baseUrl
                ) +
                quote
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

    return output;
}

async function readBody(req) {
    if (
        req.body !== undefined &&
        req.body !== null
    ) {
        if (Buffer.isBuffer(req.body)) {
            return req.body;
        }

        if (typeof req.body === "string") {
            return Buffer.from(req.body);
        }

        if (
            typeof req.body === "object"
        ) {
            return Buffer.from(
                JSON.stringify(req.body)
            );
        }
    }

    if (
        !req.readable ||
        typeof req.on !== "function"
    ) {
        return null;
    }

    return await new Promise(
        (resolve, reject) => {
            const chunks = [];

            req.on(
                "data",
                (chunk) => {
                    chunks.push(
                        Buffer.from(chunk)
                    );
                }
            );

            req.on(
                "end",
                () => {
                    resolve(
                        chunks.length
                            ? Buffer.concat(chunks)
                            : null
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

module.exports = async function handler(
    req,
    res
) {
    try {
        setCors(req, res);

        if (req.method === "OPTIONS") {
            res.statusCode = 204;
            return res.end();
        }

        const rawUrl =
            req.query &&
            typeof req.query.url === "string"
                ? req.query.url
                : null;

        const mode =
            req.query &&
            typeof req.query.mode === "string"
                ? req.query.mode
                : "resource";

        if (!rawUrl) {
            res.statusCode = 400;
            res.setHeader(
                "Content-Type",
                "application/json; charset=utf-8"
            );

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
            res.setHeader(
                "Content-Type",
                "application/json; charset=utf-8"
            );

            return res.end(
                JSON.stringify({
                    error: "URL invalide"
                })
            );
        }

        if (
            target.protocol !== "http:" &&
            target.protocol !== "https:"
        ) {
            res.statusCode = 400;

            return res.end(
                JSON.stringify({
                    error: "Protocole interdit"
                })
            );
        }

        await checkHost(
            target.hostname
        );

        const method =
            (req.method || "GET").toUpperCase();

        let body = undefined;

        if (
            method === "POST" ||
            method === "PUT" ||
            method === "PATCH"
        ) {
            body = await readBody(req);
        }

        const headers = {};

        const allowedHeaders = [
            "accept",
            "accept-language",
            "content-type",
            "user-agent",
            "referer"
        ];

        for (const name of allowedHeaders) {
            const value =
                req.headers?.[name];

            if (value) {
                headers[name] = value;
            }
        }

        const fetchOptions = {
            method,
            headers,
            redirect: "follow"
        };

        if (body !== undefined) {
            fetchOptions.body = body;
        }

        const upstream = await fetch(
            target.href,
            fetchOptions
        );

        let contentType =
            upstream.headers.get(
                "content-type"
            ) ||
            "application/octet-stream";

        let output;

        if (
            (mode === "frame" ||
                mode === "document") &&
            contentType.includes("text/html")
        ) {
            const html =
                await upstream.text();

            output = rewriteHtml(
                html,
                target.href
            );

            contentType =
                "text/html; charset=utf-8";
        } else if (
            contentType.includes(
                "text/css"
            )
        ) {
            const css =
                await upstream.text();

            output = rewriteCss(
                css,
                target.href
            );

            contentType =
                "text/css; charset=utf-8";
        } else {
            output =
                Buffer.from(
                    await upstream.arrayBuffer()
                );
        }

        res.statusCode =
            upstream.status;

        for (
            const [
                key,
                value
            ] of upstream.headers.entries()
        ) {
            const lower =
                key.toLowerCase();

            if (
                BLOCKED_HEADERS.has(lower)
            ) {
                continue;
            }

            if (
                lower === "content-length" ||
                lower === "content-encoding" ||
                lower === "transfer-encoding" ||
                lower === "set-cookie"
            ) {
                continue;
            }

            if (lower === "location") {
                const absolute =
                    absoluteUrl(
                        value,
                        target.href
                    );

                if (absolute) {
                    res.setHeader(
                        "Location",
                        proxyUrl(
                            absolute,
                            "frame"
                        )
                    );
                }

                continue;
            }

            try {
                res.setHeader(
                    key,
                    value
                );
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

        res.removeHeader(
            "X-Frame-Options"
        );

        res.removeHeader(
            "Content-Security-Policy"
        );

        if (Buffer.isBuffer(output)) {
            return res.end(output);
        }

        return res.end(output);
    } catch (error) {
        console.error(
            "OCTAVIUS_PROXY_ERROR:",
            error
        );

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
