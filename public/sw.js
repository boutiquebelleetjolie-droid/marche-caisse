// Garde l'application disponible sans internet (les données passent toujours par le serveur quand il répond)
const CACHE = "caisse-v1";
const FICHIERS = ["/", "/index.html", "/manifest.json", "/icon.svg", "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return; // l'API n'est jamais mise en cache
  // réseau d'abord (pour avoir la dernière version), cache si pas de connexion
  e.respondWith(fetch(e.request).then((r) => { const copie = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copie)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html"))));
});
