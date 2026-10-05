# Octavius v6

Version corrigée pour Vercel.

Correctifs principaux :
- plus de `allow-scripts` + `allow-same-origin` dans le sandbox de l'iframe ;
- les URLs `/api/proxy` générées par la page sont absolues, donc le `<base href>` du site distant ne les envoie plus vers `www.youtube.com/api/proxy` ;
- mode `frame` pour les iframes imbriquées, avec réécriture des ressources ;
- réécriture des CSS avec l'origine Octavius ;
- gestion d'OPTIONS/CORS pour les ressources proxifiées ;
- délai et taille maximale du document augmentés pour les pages lourdes.

Déploiement : mettre `index.html`, `vercel.json`, `package.json` et `api/proxy.js` à la racine du dépôt, puis redéployer sur Vercel.
