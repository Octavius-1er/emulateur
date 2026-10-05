"use strict";

/*
==================================================
OCTAVIUS
Navigation + recherche automatique
==================================================
*/

const addressInput =
  document.getElementById("address");

const navigationForm =
  document.getElementById("navigation-form");

const browserFrame =
  document.getElementById("browser-frame");

const backButton =
  document.getElementById("back");

const forwardButton =
  document.getElementById("forward");

const reloadButton =
  document.getElementById("reload");

const homeButton =
  document.getElementById("home");

const statusElement =
  document.getElementById("status");

const progressElement =
  document.getElementById("progress");


/* ==================================================
   CONFIGURATION
   ================================================== */

const PROXY_ENDPOINT = "/api/proxy";

/*
  Quand l'utilisateur écrit simplement :
  youtube
  roblox
  snapchat

  on fait automatiquement une recherche Google.
*/
const SEARCH_ENGINE =
  "https://www.google.com/search?hl=fr&q=";


/* ==================================================
   HISTORIQUE
   ================================================== */

let historyList = [];
let historyIndex = -1;

let currentRequestId = 0;


/* ==================================================
   INTERFACE
   ================================================== */

function setStatus(message, isError = false) {
  statusElement.textContent = message;

  statusElement.classList.toggle(
    "error",
    isError
  );
}


function setLoading(loading) {
  if (loading) {
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
  backButton.disabled =
    historyIndex <= 0;

  forwardButton.disabled =
    historyIndex < 0 ||
    historyIndex >= historyList.length - 1;
}


/* ==================================================
   DÉTECTION URL / RECHERCHE
   ================================================== */

function normalizeAddress(value) {
  value = String(value || "").trim();

  if (!value) {
    return null;
  }


  /*
   * URL complète :
   * https://youtube.com
   */
  if (/^https?:\/\//i.test(value)) {
    return value;
  }


  /*
   * www.youtube.com
   */
  if (/^www\./i.test(value)) {
    return "https://" + value;
  }


  /*
   * youtube.com
   * roblox.com/games
   */
  if (
    !/\s/.test(value) &&
    /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i.test(value)
  ) {
    return "https://" + value;
  }


  /*
   * Tout le reste devient
   * une recherche Google.
   *
   * Exemples :
   * youtube
   * roblox
   * snapchat
   * chatgpt
   * comment faire une carte mentale
   */
  return (
    SEARCH_ENGINE +
    encodeURIComponent(value)
  );
}


/* ==================================================
   CONSTRUCTION URL PROXY
   ================================================== */

function buildProxyUrl(targetUrl, mode) {
  return (
    PROXY_ENDPOINT +
    "?mode=" +
    encodeURIComponent(mode) +
    "&url=" +
    encodeURIComponent(targetUrl)
  );
}


/* ==================================================
   CHARGEMENT D'UNE PAGE
   ================================================== */

async function loadPage(
  targetUrl,
  options = {}
) {
  const {
    addToHistory = true
  } = options;

  const requestId =
    ++currentRequestId;

  setLoading(true);

  setStatus(
    "Chargement de " +
    targetUrl +
    "..."
  );

  try {

    /*
     * Étape 1 :
     * demander les informations de la page
     * au proxy.
     */

    const response =
      await fetch(
        buildProxyUrl(
          targetUrl,
          "document"
        ),
        {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",

          headers: {
            "Accept":
              "application/json"
          }
        }
      );


    /*
     * Une navigation plus récente
     * a commencé.
     */

    if (
      requestId !==
      currentRequestId
    ) {
      return;
    }


    /*
     * Vérifie que le proxy a réellement
     * envoyé du JSON.
     */

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    if (
      !contentType.includes(
        "application/json"
      )
    ) {
      throw new Error(
        "Réponse inattendue du proxy (" +
        response.status +
        ")"
      );
    }


    const data =
      await response.json();


    if (
      requestId !==
      currentRequestId
    ) {
      return;
    }


    /*
     * Erreur du proxy.
     */

    if (
      !response.ok ||
      data.erreur
    ) {
      throw new Error(
        data.erreur ||
        (
          "Erreur HTTP " +
          response.status
        )
      );
    }


    /*
     * Étape 2 :
     * afficher la page dans l'iframe.
     */

    browserFrame.src =
      buildProxyUrl(
        data.url,
        "frame"
      );


    /*
     * Met à jour la barre d'adresse.
     */

    addressInput.value =
      data.url;


    /*
     * Historique.
     */

    if (addToHistory) {

      historyList =
        historyList.slice(
          0,
          historyIndex + 1
        );

      historyList.push(
        data.url
      );

      historyIndex++;
    }


    updateHistoryButtons();


    setStatus(
      "Page chargée — HTTP " +
      data.statut
    );

    setLoading(false);

  } catch (error) {

    if (
      requestId !==
      currentRequestId
    ) {
      return;
    }

    setLoading(false);

    setStatus(
      "Erreur : " +
      (
        error?.message ||
        String(error)
      ),
      true
    );
  }
}


/* ==================================================
   BARRE D'ADRESSE
   ================================================== */

navigationForm.addEventListener(
  "submit",
  (event) => {

    event.preventDefault();

    const targetUrl =
      normalizeAddress(
        addressInput.value
      );

    if (!targetUrl) {
      return;
    }

    loadPage(targetUrl);
  }
);


/* ==================================================
   BOUTON PRÉCÉDENT
   ================================================== */

backButton.addEventListener(
  "click",
  () => {

    if (
      historyIndex <= 0
    ) {
      return;
    }

    historyIndex--;

    const targetUrl =
      historyList[
        historyIndex
      ];

    updateHistoryButtons();

    loadPage(
      targetUrl,
      {
        addToHistory: false
      }
    );
  }
);


/* ==================================================
   BOUTON SUIVANT
   ================================================== */

forwardButton.addEventListener(
  "click",
  () => {

    if (
      historyIndex >=
      historyList.length - 1
    ) {
      return;
    }

    historyIndex++;

    const targetUrl =
      historyList[
        historyIndex
      ];

    updateHistoryButtons();

    loadPage(
      targetUrl,
      {
        addToHistory: false
      }
    );
  }
);


/* ==================================================
   RECHARGER
   ================================================== */

reloadButton.addEventListener(
  "click",
  () => {

    if (
      historyIndex < 0
    ) {
      return;
    }

    const targetUrl =
      historyList[
        historyIndex
      ];

    loadPage(
      targetUrl,
      {
        addToHistory: false
      }
    );
  }
);


/* ==================================================
   ACCUEIL
   ================================================== */

homeButton.addEventListener(
  "click",
  () => {

    browserFrame.removeAttribute(
      "src"
    );

    addressInput.value = "";

    setStatus("Prêt.");

    setLoading(false);
  }
);


/* ==================================================
   NAVIGATION DEPUIS UNE PAGE
   ==================================================

   Le proxy injecte un petit bridge
   qui envoie :

   {
     type: "navigate",
     url: "..."
   }

   à Octavius.
   ================================================== */

window.addEventListener(
  "message",
  (event) => {

    /*
     * On accepte uniquement les messages
     * provenant de notre iframe.
     */

    if (
      event.source !==
      browserFrame.contentWindow
    ) {
      return;
    }


    const message =
      event.data;


    if (
      !message ||
      typeof message !== "object"
    ) {
      return;
    }


    if (
      message.type !==
      "navigate"
    ) {
      return;
    }


    if (
      typeof message.url !==
      "string"
    ) {
      return;
    }


    loadPage(
      message.url
    );
  }
);


/* ==================================================
   IFRAME CHARGÉ
   ================================================== */

browserFrame.addEventListener(
  "load",
  () => {

    setLoading(false);

    if (
      historyIndex >= 0
    ) {
      setStatus(
        "Page affichée."
      );
    }
  }
);


/* ==================================================
   RACCOURCIS CLAVIER
   ================================================== */

/*
   Ctrl + L
   → sélectionner la barre d'adresse
*/

document.addEventListener(
  "keydown",
  (event) => {

    if (
      event.ctrlKey &&
      event.key.toLowerCase() === "l"
    ) {

      event.preventDefault();

      addressInput.focus();
      addressInput.select();

      return;
    }


    /*
     * Alt + ←
     */

    if (
      event.altKey &&
      event.key === "ArrowLeft"
    ) {

      event.preventDefault();

      backButton.click();

      return;
    }


    /*
     * Alt + →
     */

    if (
      event.altKey &&
      event.key === "ArrowRight"
    ) {

      event.preventDefault();

      forwardButton.click();

      return;
    }


    /*
     * F5
     */

    if (
      event.key === "F5"
    ) {

      event.preventDefault();

      reloadButton.click();
    }
  }
);


/* ==================================================
   DÉMARRAGE
   ================================================== */

updateHistoryButtons();

setStatus("Prêt.");
