// Vercel serverless function : /api/proxy?url=...
// Récupère une page web publique, retire ses scripts,
// et injecte un petit script qui renvoie les clics au navigateur parent.

function interdit(host) {
  return (
    !host.includes('.') ||
    /^(localhost|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host)
  );
}

const NAV = `<script>
document.addEventListener('click',function(e){
  var a=e.target.closest('a[href]'); if(!a) return;
  e.preventDefault(); parent.postMessage({go:a.href},'*');
});
document.addEventListener('submit',function(e){
  e.preventDefault(); var f=e.target;
  if((f.method||'get').toLowerCase()!=='get') return;
  var u=new URL(f.action||location.href);
  new FormData(f).forEach(function(v,k){u.searchParams.set(k,v)});
  parent.postMessage({go:u.href},'*');
});
</script>`;

module.exports = async (req, res) => {
  try {
    const u = new URL(req.query.url);
    if (!['http:', 'https:'].includes(u.protocol) || interdit(u.hostname)) {
      return res.status(400).json({ erreur: 'Adresse refusée' });
    }
    const r = await fetch(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (emulateur-pedagogique-college)',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    const final = new URL(r.url);
    if (interdit(final.hostname)) {
      return res.status(400).json({ erreur: 'Redirection refusée' });
    }
    const type = r.headers.get('content-type') || '';
    if (!type.includes('html')) {
      return res.status(415).json({ erreur: 'Ce n\'est pas une page web (' + type + ')' });
    }
    let html = (await r.text()).slice(0, 800000);
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = `<base href="${final.href}">` + html + NAV;
    return res.status(200).json({ statut: r.status, url: final.href, html });
  } catch (e) {
    return res.status(500).json({ erreur: String(e.message || e) });
  }
};
