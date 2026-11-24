// Service worker: makes Sabre Wulf installable and playable 100% offline.
// Stamped at build time by vite.config.js so every release gets its own versioned cache.
const CACHE = "sabre-wulf-__APP_VERSION__";
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "__PRECACHE_ASSETS__"
].filter((u) => u && !u.includes("PRECACHE_ASSETS"));

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Allow the page to register any extra runtime resources for offline play.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_URLS") return;
  const urls = (event.data.urls || []).filter(
    (u) => new URL(u).origin === self.location.origin,
  );
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.all(urls.map((u) => cache.add(u).catch(() => {}))),
      ),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin)
    return;

  // Navigation: network first (so new GitHub Pages deploys show up), fallback to cache offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match("./index.html")),
        ),
    );
    return;
  }

  // Static assets: cache first, refresh in the background when online.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
