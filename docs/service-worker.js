self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("static-cache-v1").then((cache) => {
      return cache.addAll([
        "./",
        "./index.html",
        "./assets/icons/icon_180.png",
        "./assets/icons/icon_192.png",
        "./assets/icons/icon_512.png",
      ]);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    }),
  );
});
