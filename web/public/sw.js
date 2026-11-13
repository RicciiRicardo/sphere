// Sphere's service worker. It exists so the phone can install Sphere as an
// app; it caches nothing, so every launch loads the latest version. When the
// phone is offline, opening the app shows a short notice instead of an error.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sphere</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ee;font:16px/1.5 -apple-system,system-ui,sans-serif;text-align:center;padding:24px}button{margin-top:16px;padding:10px 18px;border-radius:8px;border:0;background:#6d8bff;color:#fff;font:inherit}</style></head>
<body><div><p><strong>You're offline.</strong></p><p>Sphere needs a connection to reach the team.</p><button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    ),
  );
});
