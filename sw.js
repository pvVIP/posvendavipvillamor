const CACHE_NAME = "villamor-inadimplencia-v10";
const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  "./css/style.css?v=20260612-5",
  "./js/app.js?v=20260612-5",
  "./js/config.js",
  "./js/data-provider.js?v=20260612-5",
  "./js/database.js?v=20260611-1",
  "./js/supabase-client.js?v=20260611-1",
  "./js/supabase-provider.js?v=20260612-5",
  "./js/storage.js?v=20260609-5",
  "./js/distratos.js?v=20260612-5",
  "./js/upload.js?v=20260609-4",
  "./js/charts.js",
  "./js/dashboard.js?v=20260609-7",
  "./js/insights.js?v=20260609-7",
  "./js/utils.js",
  "./assets/logo.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./offline.html"))),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && new URL(event.request.url).origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    })),
  );
});
