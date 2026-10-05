# Octavius — émulateur de navigateur v5

## Correction principale
La page affichée dans l'iframe autorise désormais `allow-same-origin` afin que les applications Web modernes puissent utiliser correctement leur origine, `localStorage`, certaines APIs Web et leur initialisation JavaScript. Cela améliore fortement les sites comme YouTube qui peuvent rester bloqués sur leur écran de chargement dans un iframe avec une origine opaque.

Le proxy reste nécessaire pour charger les ressources externes.

## Structure
```text
/
├── index.html
├── package.json
├── vercel.json
└── api/
    └── proxy.js
```

## Déploiement
Vercel détecte automatiquement `api/proxy.js`. Ne pas ajouter de champ `runtime` dans `vercel.json`.

## Limites
Un proxy HTML ne reproduira pas parfaitement tous les sites modernes : WebSockets, DRM, protections anti-bot, cookies tiers, service workers et certaines APIs propriétaires peuvent rester incompatibles.
