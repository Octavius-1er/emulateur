# Octavius — émulateur de navigateur

Projet prévu pour GitHub + Vercel.

## Structure

- `index.html` — interface de l'émulateur
- `api/proxy.js` — proxy Vercel pour les pages et leurs ressources
- `vercel.json` — configuration Vercel

## Déploiement

Le dépôt GitHub doit avoir exactement cette structure :

```text
/
├── index.html
├── vercel.json
└── api/
    └── proxy.js
```

Le projet doit être déployé avec Vercel, pas avec GitHub Pages, car `/api/proxy` est une fonction serveur.

## Limites

Un proxy de ce type améliore nettement les sites HTML classiques, les CSS, images, scripts et ressources, mais ne peut pas reproduire parfaitement tous les sites modernes. Les applications qui dépendent fortement de WebSockets, de stockage/cookies tiers, de DRM, de protections anti-bot ou de politiques de sécurité complexes peuvent rester partiellement incompatibles.
