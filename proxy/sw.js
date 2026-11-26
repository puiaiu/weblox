importScripts("/proxy/controller/controller.sw.js");

addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

addEventListener("fetch", (event) => {
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
  }
});
