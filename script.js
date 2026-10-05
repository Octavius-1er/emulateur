const frame = document.getElementById("browser-frame");
const addressBar = document.getElementById("address-bar");
const progressBar = document.getElementById("progress-bar");

const backButton = document.getElementById("back-button");
const forwardButton = document.getElementById("forward-button");
const reloadButton = document.getElementById("reload-button");
const homeButton = document.getElementById("home-button");

const PROXY_ENDPOINT = "/api/proxy";
const SEARCH_ENGINE = "https://www.google.com/search?hl=fr&q=";

let historyStack = [];
let historyIndex = -1;
let loadingFromHistory = false;

function isHttpUrl(value) {
    return /^https?:\/\//i.test(value);
}

function looksLikeDomain(value) {
    return /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(value);
}

function normalizeAddress(input) {
    let value = input.trim();

    if (!value) {
        return null;
    }

    if (isHttpUrl(value)) {
        return value;
    }

    if (/^www\./i.test(value)) {
        return "https://" + value;
    }

    if (looksLikeDomain(value)) {
        return "https://" + value;
    }

    return SEARCH_ENGINE + encodeURIComponent(value);
}

function buildProxyUrl(targetUrl, mode = "frame") {
    return (
        PROXY_ENDPOINT +
        "?mode=" +
        encodeURIComponent(mode) +
        "&url=" +
        encodeURIComponent(targetUrl)
    );
}

function setProgress(value) {
    if (!progressBar) return;

    progressBar.style.width = value + "%";

    if (value >= 100) {
        setTimeout(() => {
            progressBar.style.width = "0%";
        }, 250);
    }
}

function updateButtons() {
    if (backButton) {
        backButton.disabled = historyIndex <= 0;
    }

    if (forwardButton) {
        forwardButton.disabled =
            historyIndex < 0 || historyIndex >= historyStack.length - 1;
    }
}

function setAddress(url) {
    if (addressBar) {
        addressBar.value = url;
    }
}

function addToHistory(url) {
    if (loadingFromHistory) {
        loadingFromHistory = false;
        return;
    }

    if (historyIndex >= 0 && historyStack[historyIndex] === url) {
        updateButtons();
        return;
    }

    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(url);
    historyIndex = historyStack.length - 1;

    updateButtons();
}

function getInitialUrl() {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("url");

    if (requested) {
        return requested;
    }

    return "https://www.google.com/";
}

function showError(message) {
    frame.srcdoc = `
        <!DOCTYPE html>
        <html lang="fr">
        <head>
            <meta charset="UTF-8">
            <title>Octavius - Erreur</title>
            <style>
                body {
                    margin: 0;
                    background: #111827;
                    color: #e5e7eb;
                    font-family: Arial, sans-serif;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 100vh;
                }

                .box {
                    max-width: 700px;
                    padding: 30px;
                    text-align: center;
                }

                h1 {
                    margin-bottom: 12px;
                }

                p {
                    color: #9ca3af;
                    line-height: 1.6;
                }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>Impossible de charger cette page</h1>
                <p>${escapeHtml(message)}</p>
            </div>
        </body>
        </html>
    `;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function loadPage(rawUrl, options = {}) {
    const {
        addHistory = true
    } = options;

    const targetUrl = normalizeAddress(rawUrl);

    if (!targetUrl) {
        return;
    }

    setProgress(15);
    setAddress(targetUrl);

    if (addHistory) {
        addToHistory(targetUrl);
    }

    const proxyUrl = buildProxyUrl(targetUrl, "frame");

    frame.onload = () => {
        setProgress(100);
    };

    frame.onerror = () => {
        setProgress(0);
        showError("Le proxy n’a pas réussi à charger cette page.");
    };

    frame.src = proxyUrl;
}

function goBack() {
    if (historyIndex <= 0) {
        return;
    }

    historyIndex--;
    loadingFromHistory = true;

    const url = historyStack[historyIndex];

    updateButtons();
    setAddress(url);
    loadPage(url, { addHistory: false });
}

function goForward() {
    if (historyIndex >= historyStack.length - 1) {
        return;
    }

    historyIndex++;
    loadingFromHistory = true;

    const url = historyStack[historyIndex];

    updateButtons();
    setAddress(url);
    loadPage(url, { addHistory: false });
}

function reloadPage() {
    if (!frame.src) {
        loadPage(getInitialUrl());
        return;
    }

    setProgress(20);

    try {
        const current = new URL(frame.src, window.location.origin);
        const proxiedTarget = current.searchParams.get("url");

        if (proxiedTarget) {
            frame.src = buildProxyUrl(proxiedTarget, "frame");
        } else {
            frame.src = frame.src;
        }
    } catch {
        frame.src = frame.src;
    }
}

function goHome() {
    loadPage("https://www.google.com/");
}

function handleAddressSubmit() {
    if (!addressBar) return;

    const value = addressBar.value.trim();

    if (!value) {
        return;
    }

    loadPage(value);
}

if (addressBar) {
    addressBar.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            handleAddressSubmit();
        }
    });

    addressBar.addEventListener("focus", () => {
        addressBar.select();
    });
}

if (backButton) {
    backButton.addEventListener("click", goBack);
}

if (forwardButton) {
    forwardButton.addEventListener("click", goForward);
}

if (reloadButton) {
    reloadButton.addEventListener("click", reloadPage);
}

if (homeButton) {
    homeButton.addEventListener("click", goHome);
}

window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();

        if (addressBar) {
            addressBar.focus();
            addressBar.select();
        }
    }

    if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        goBack();
    }

    if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        goForward();
    }

    if (event.key === "F5") {
        event.preventDefault();
        reloadPage();
    }
});

window.addEventListener("message", (event) => {
    if (!event.data || typeof event.data !== "object") {
        return;
    }

    if (event.data.type === "octavius:navigate") {
        if (typeof event.data.url === "string") {
            loadPage(event.data.url);
        }
    }
});

window.addEventListener("load", () => {
    const initialUrl = getInitialUrl();

    historyStack = [];
    historyIndex = -1;

    loadPage(initialUrl);
    updateButtons();
});
