const CACHE_NAME = "static-cache-v1.6.1";
const FILES_TO_CACHE = [
  "./",
  "./index.html",
  "./indexedDB.js",
  "./assets/icons/icon_180.png",
  "./assets/icons/icon_192.png",
  "./assets/icons/icon_512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Pre-caching offline page");
      return cache.addAll(FILES_TO_CACHE);
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("Activating new service worker...");
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          if (cacheWhitelist.indexOf(key) === -1) {
            console.log("Deleting old cache:", key);
            return caches.delete(key);
          }
        }),
      );
    }),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    }),
  );
});
