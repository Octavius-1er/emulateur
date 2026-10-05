"use strict";

/*
==================================================
OCTAVIUS
Navigateur Web avec proxy Vercel
==================================================
*/

const addressInput = document.getElementById("address");
const navigationForm = document.getElementById("navigation-form");
const browserFrame = document.getElementById("browser-frame");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const reloadButton = document.getElementById("reload");
const homeButton = document.getElementById("home");
const statusElement = document.getElementById("status");
const progressElement = document.getElementById("progress");

const PROXY_ENDPOINT = "/api/proxy";

let accessToken = "";
try { accessToken = sessionStorage.getItem("octavius_k") || ""; } catch {}

const SEARCH_ENGINE = "https://html.duckduckgo.com/html/?q=";

let navigationHistory = [];
let currentHistoryIndex = -1;
let navigationRequestId = 0;

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

function setLoading(isLoading) {
  if (isLoading) {
    progressElement.style.opacity = "1";
    progressElement.style.width = "70%";
  } else {
    progressElement.style.width = "100%";
    setTimeout(() => {
      progressElement.style.opacity = "0";
      progressElement.style.width = "0";
    }, 200);
  }
}

function updateHistoryButtons() {
  backButton.disabled = currentHistoryIndex <= 0;
  forwardButton.disabled =
    currentHistoryIndex < 0 ||
    currentHistoryIndex >= navigationHistory.length - 1;
}

function normalizeAddress(value) {
  value = String(value || "").trim();

  if (!value) {
    return null;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (/^www\./i.test(value)) {
    return "https://" + value;
  }

  if (
    !/\s/.test(value) &&
    /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(value)
  ) {
    return "https://" + value;
  }

  return SEARCH_ENGINE + encodeURIComponent(value);
}

function buildProxyUrl(targetUrl, mode = "document") {
  return (
    PROXY_ENDPOINT +
    "?mode=" +
    encodeURIComponent(mode) +
    "&url=" +
    encodeURIComponent(targetUrl) +
    (accessToken ? "&k=" + encodeURIComponent(accessToken) : "")
  );
}

async function loadPage(targetUrl, options = {}) {
  const { addToHistory = true } = options;

  const requestId = ++navigationRequestId;

  const embed = youtubeEmbedUrl(targetUrl);

  if (embed) {
    showYoutube(embed, targetUrl, addToHistory);
    return;
  }

  if (isYoutubePage(targetUrl)) {
    showYoutubeHelp(targetUrl, addToHistory);
    return;
  }

  showWeb();

  setLoading(true);
  setStatus("Chargement de " + targetUrl + "...");

  try {
    const response = await fetch(buildProxyUrl(targetUrl, "document"), {
      method: "GET",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });

    if (requestId !== navigationRequestId) {
      return;
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      throw new Error(
        "Le proxy n'a pas renvoyé du JSON (" + response.status + ")."
      );
    }

    const data = await response.json();

    if (requestId !== navigationRequestId) {
      return;
    }

    if (!response.ok || data.erreur) {
      throw new Error(data.erreur || ("Erreur HTTP " + response.status));
    }

    browserFrame.src = buildProxyUrl(data.url, "frame");

    addressInput.value = data.url;

    if (addToHistory) {
      navigationHistory = navigationHistory.slice(0, currentHistoryIndex + 1);
      navigationHistory.push(data.url);
      currentHistoryIndex++;
    }

    updateHistoryButtons();

    setStatus("Page chargée — HTTP " + data.statut);

    setLoading(false);
  } catch (error) {
    if (requestId !== navigationRequestId) {
      return;
    }

    setLoading(false);

    setStatus("Erreur : " + (error?.message || String(error)), true);
  }
}

navigationForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const targetUrl = normalizeAddress(addressInput.value);

  if (!targetUrl) {
    return;
  }

  loadPage(targetUrl);
});

backButton.addEventListener("click", () => {
  if (currentHistoryIndex <= 0) {
    return;
  }

  currentHistoryIndex--;

  const targetUrl = navigationHistory[currentHistoryIndex];

  updateHistoryButtons();

  loadPage(targetUrl, { addToHistory: false });
});

forwardButton.addEventListener("click", () => {
  if (currentHistoryIndex >= navigationHistory.length - 1) {
    return;
  }

  currentHistoryIndex++;

  const targetUrl = navigationHistory[currentHistoryIndex];

  updateHistoryButtons();

  loadPage(targetUrl, { addToHistory: false });
});

reloadButton.addEventListener("click", () => {
  if (currentHistoryIndex < 0) {
    return;
  }

  loadPage(navigationHistory[currentHistoryIndex], { addToHistory: false });
});

homeButton.addEventListener("click", () => {
  showWeb();

  browserFrame.removeAttribute("src");

  addressInput.value = "";

  setStatus("Prêt.");

  setLoading(false);
});

window.addEventListener("message", (event) => {
  if (event.source !== browserFrame.contentWindow) {
    return;
  }

  const message = event.data;

  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "blocked") {
    setStatus(String(message.reason || "Action bloquée"), true);
    return;
  }

  if (message.type !== "navigate") {
    return;
  }

  if (typeof message.url !== "string") {
    return;
  }

  loadPage(message.url);
});

browserFrame.addEventListener("load", () => {
  setLoading(false);

  if (currentHistoryIndex >= 0) {
    setStatus("Page affichée.");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    addressInput.focus();
    addressInput.select();
    return;
  }

  if (event.altKey && event.key === "ArrowLeft") {
    event.preventDefault();
    backButton.click();
    return;
  }

  if (event.altKey && event.key === "ArrowRight") {
    event.preventDefault();
    forwardButton.click();
    return;
  }

  if (event.key === "F5") {
    event.preventDefault();
    reloadButton.click();
  }
});

updateHistoryButtons();

setStatus("Prêt.");

/* ================================================
   YOUTUBE (lecteur officiel) + CODE D'ACCÈS
   ================================================ */

const youtubeFrame = document.getElementById("youtube-frame");
const loginForm = document.getElementById("login");
const loginCode = document.getElementById("login-code");
const loginError = document.getElementById("login-error");

function showWeb() {
  youtubeFrame.hidden = true;
  youtubeFrame.removeAttribute("src");
  browserFrame.removeAttribute("srcdoc");
  browserFrame.hidden = false;
}

function pushHistory(url, addToHistory) {
  if (addToHistory) {
    navigationHistory = navigationHistory.slice(0, currentHistoryIndex + 1);
    navigationHistory.push(url);
    currentHistoryIndex++;
  }
  updateHistoryButtons();
}

function isYoutubePage(raw) {
  try {
    const h = new URL(raw).hostname.replace(/^(www\.|m\.|music\.)/, "");
    return h === "youtube.com" || h === "youtu.be" || h === "youtube-nocookie.com";
  } catch {
    return false;
  }
}

function youtubeEmbedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }

  const h = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
  const list = u.searchParams.get("list");
  const okList = list && /^[\w-]+$/.test(list);
  let id = null;

  if (h === "youtu.be") {
    id = u.pathname.slice(1).split("/")[0];
  } else if (h === "youtube.com" || h === "youtube-nocookie.com") {
    if (u.pathname === "/watch") {
      id = u.searchParams.get("v");
    } else {
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})/);
      if (m) id = m[2];
    }
  }

  if (id && /^[\w-]{11}$/.test(id)) {
    let src = "https://www.youtube-nocookie.com/embed/" + id + "?rel=0&playsinline=1";
    if (okList) src += "&list=" + list;
    const t = u.searchParams.get("t") || u.searchParams.get("start");
    if (t && /^\d+s?$/.test(t)) src += "&start=" + parseInt(t, 10);
    return src;
  }

  if (h === "youtube.com" && u.pathname === "/playlist" && okList) {
    return "https://www.youtube-nocookie.com/embed/videoseries?list=" + list;
  }

  return null;
}

function showYoutube(embed, pageUrl, addToHistory) {
  browserFrame.hidden = true;
  youtubeFrame.hidden = false;
  youtubeFrame.src = embed;
  addressInput.value = pageUrl;
  pushHistory(pageUrl, addToHistory);
  setLoading(false);
  setStatus("Lecteur YouTube officiel (la vidéo ne passe pas par le proxy)");
}

function showYoutubeHelp(pageUrl, addToHistory) {
  showWeb();
  browserFrame.srcdoc =
    '<body style="font:16px system-ui;background:#0f172a;color:#e5e7eb;padding:32px;max-width:560px;margin:auto">' +
    "<h2>YouTube</h2>" +
    "<p>Le site YouTube complet ne peut pas passer par un proxy. " +
    "Colle l'adresse d'une vidéo ou d'une playlist dans la barre d'adresse : " +
    "elle s'ouvrira dans le lecteur officiel.</p>" +
    '<p style="color:#94a3b8">Exemple : https://www.youtube.com/watch?v=...</p></body>';
  addressInput.value = pageUrl;
  pushHistory(pageUrl, addToHistory);
  setLoading(false);
  setStatus("Colle un lien de vidéo YouTube");
}

async function checkAccess() {
  try {
    const r = await fetch(
      PROXY_ENDPOINT + "?mode=auth" +
        (accessToken ? "&k=" + encodeURIComponent(accessToken) : ""),
      { cache: "no-store" }
    );
    const d = await r.json();
    if (d.erreur) { setStatus(d.erreur, true); return; }
    if (d.needsCode && !d.valid) {
      try { sessionStorage.removeItem("octavius_k"); } catch {}
      accessToken = "";
      loginForm.hidden = false;
      loginCode.focus();
    }
  } catch {}
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  try {
    const r = await fetch(
      PROXY_ENDPOINT + "?mode=auth&code=" + encodeURIComponent(loginCode.value),
      { cache: "no-store" }
    );
    const d = await r.json();
    if (!d.ok) throw new Error(d.erreur || "Code incorrect");
    accessToken = d.k;
    try { sessionStorage.setItem("octavius_k", accessToken); } catch {}
    loginCode.value = "";
    loginForm.hidden = true;
    addressInput.focus();
  } catch (e) {
    loginError.textContent = e.message;
  }
});

checkAccess();
