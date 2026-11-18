// Service worker: lets Scrobble Studio open without internet and be installed as an app.
// The app's own files are cached; your data lives in the browser's storage, not here.
// Bump VERSION after changing files so devices pick up the new version.
const VERSION = "ss-v3";
const FILES = [
  "./", "index.html", "settings.html", "locations.html", "style.css",
  "js/engine.js", "js/app.js", "js/settings.js", "js/locations.js", "js/chart.umd.min.js",
  "js/nav.js", "js/trends.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files: network first (so updates arrive), cache as fallback when offline.
// Everything else (Last.fm, Spotify, Open-Meteo) goes straight to the network.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
