"use strict";

/*
==================================================
OCTAVIUS
Navigateur Web avec proxy Vercel
==================================================
*/

/* ================================================
   ÉLÉMENTS HTML
   ================================================ */

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


/* ================================================
   CONFIGURATION
   ================================================ */

const PROXY_ENDPOINT = "/api/proxy";

const SEARCH_ENGINE =
  "https://www.bing.com/search?q=";


/*
   Historique interne de l'émulateur.
*/
let navigationHistory = [];

let currentHistoryIndex = -1;


/*
   Permet d'annuler logiquement les anciennes
   requêtes lorsqu'une nouvelle page est demandée.
*/
let navigationRequestId = 0;


/* ================================================
   UTILITAIRES
   ================================================ */

function setStatus(message, isError = false) {

  statusElement.textContent = message;

  statusElement.classList.toggle(
    "error",
    isError
  );
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

  backButton.disabled =
    currentHistoryIndex <= 0;

  forwardButton.disabled =
    currentHistoryIndex < 0 ||
    currentHistoryIndex >=
      navigationHistory.length - 1;
}


/*
   Transforme ce que l'utilisateur écrit
   en véritable URL.
*/
function normalizeAddress(value) {

  value =
    String(value || "").trim();

  if (!value) {
    return null;
  }


  /*
     URL déjà complète.
  */

  if (
    /^https?:\/\//i.test(value)
  ) {

    return value;
  }


  /*
     www.example.com
  */

  if (
    /^www\./i.test(value)
  ) {

    return "https://" + value;
  }


  /*
     example.com
  */

  if (
    !/\s/.test(value) &&
    /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/.*)?$/i
      .test(value)
  ) {

    return "https://" + value;
  }


  /*
     Sinon, recherche Web.
  */

  return (
    SEARCH_ENGINE +
    encodeURIComponent(value)
  );
}


/* ================================================
   CONSTRUCTION DES URLS DU PROXY
   ================================================ */

function buildProxyUrl(
  targetUrl,
  mode = "document"
) {

  return (
    PROXY_ENDPOINT +
    "?mode=" +
    encodeURIComponent(mode) +
    "&url=" +
    encodeURIComponent(targetUrl)
  );
}


/* ================================================
   CHARGEMENT D'UNE PAGE
   ================================================ */

async function loadPage(
  targetUrl,
  options = {}
) {

  const {
    addToHistory = true
  } = options;


  const requestId =
    ++navigationRequestId;


  setLoading(true);

  setStatus(
    "Chargement de " +
    targetUrl +
    "..."
  );


  try {

    /*
       Demande au proxy de récupérer
       les informations de la page.
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

          headers: {
            "Accept":
              "application/json"
          }
        }
      );


    /*
       Si une nouvelle navigation a commencé,
       cette réponse n'est plus utile.
    */

    if (
      requestId !== navigationRequestId
    ) {

      return;
    }


    /*
       Vérification du type de réponse.
    */

    const contentType =
      response.headers
        .get("content-type") || "";


    if (
      !contentType.includes(
        "application/json"
      )
    ) {

      throw new Error(
        "Le proxy n'a pas renvoyé du JSON (" +
        response.status +
        ")."
      );
    }


    const data =
      await response.json();


    if (
      requestId !== navigationRequestId
    ) {

      return;
    }


    /*
       Erreur renvoyée par le proxy.
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
       On demande ensuite au proxy
       de servir la page dans l'iframe.
    */

    const frameUrl =
      buildProxyUrl(
        data.url,
        "frame"
      );


    browserFrame.src =
      frameUrl;


    /*
       Met à jour la barre d'adresse.
    */

    addressInput.value =
      data.url;


    /*
       Historique.
    */

    if (addToHistory) {

      navigationHistory =
        navigationHistory.slice(
          0,
          currentHistoryIndex + 1
        );

      navigationHistory.push(
        data.url
      );

      currentHistoryIndex++;
    }


    updateHistoryButtons();


    setStatus(
      "Page chargée — HTTP " +
      data.statut
    );


    setLoading(false);

  } catch (error) {

    if (
      requestId !== navigationRequestId
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


/* ================================================
   NAVIGATION
   ================================================ */

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


/* ================================================
   PRÉCÉDENT
   ================================================ */

backButton.addEventListener(
  "click",
  () => {

    if (
      currentHistoryIndex <= 0
    ) {

      return;
    }


    currentHistoryIndex--;


    const targetUrl =
      navigationHistory[
        currentHistoryIndex
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


/* ================================================
   SUIVANT
   ================================================ */

forwardButton.addEventListener(
  "click",
  () => {

    if (
      currentHistoryIndex >=
      navigationHistory.length - 1
    ) {

      return;
    }


    currentHistoryIndex++;


    const targetUrl =
      navigationHistory[
        currentHistoryIndex
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


/* ================================================
   RECHARGER
   ================================================ */

reloadButton.addEventListener(
  "click",
  () => {

    if (
      currentHistoryIndex < 0
    ) {

      return;
    }


    const currentUrl =
      navigationHistory[
        currentHistoryIndex
      ];


    loadPage(
      currentUrl,
      {
        addToHistory: false
      }
    );
  }
);


/* ================================================
   ACCUEIL
   ================================================ */

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


/* ================================================
   COMMUNICATION AVEC LA PAGE
   ================================================ */

/*
   Le proxy injecte un petit script
   dans les pages.

   Ce script peut demander à Octavius
   de naviguer vers une nouvelle URL.
*/

window.addEventListener(
  "message",
  (event) => {

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


/* ================================================
   ÉVÉNEMENTS DE L'IFRAME
   ================================================ */

browserFrame.addEventListener(
  "load",
  () => {

    setLoading(false);

    /*
       On ne considère pas ça comme une erreur :
       certaines pages refusent certaines
       fonctionnalités même lorsqu'elles sont
       correctement chargées.
    */

    if (
      currentHistoryIndex >= 0
    ) {

      setStatus(
        "Page affichée."
      );
    }
  }
);


/* ================================================
   RACCOURCIS CLAVIER
   ================================================ */

document.addEventListener(
  "keydown",
  (event) => {

    /*
       Ctrl + L
    */

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
       Alt + ←
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
       Alt + →
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
       F5
    */

    if (
      event.key === "F5"
    ) {

      event.preventDefault();

      reloadButton.click();
    }
  }
);


/* ================================================
   DÉMARRAGE
   ================================================ */

updateHistoryButtons();

setStatus("Prêt.");
