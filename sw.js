// Service worker: lets Scrobble Studio open without internet and be installed as an app.
// The app's own files are cached; your data lives in the browser's storage, not here.
// After changing files: bump VERSION here AND the ?v= number on every script/style link in the HTML pages,
// so a new page never runs with old (cached) script files.
const VERSION = "ss-v21";
const FILES = [
  "./", "index.html", "settings.html", "locations.html", "style.css",
  "js/engine.js", "js/app.js", "js/settings.js", "js/locations.js", "js/chart.umd.min.js",
  "js/nav.js", "js/race.js", "js/song.js", "js/songlab.js",
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
// "no-cache" makes the browser check GitHub for a newer copy instead of reusing its own
// 10-minute copy, which could mix new pages with old scripts.
// Everything else (Last.fm, Spotify, Open-Meteo) goes straight to the network.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" })
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
