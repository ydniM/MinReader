// Lets Chrome install the reader as an app. It doesn't save anything for
// offline use: every request goes to the internet as normal, and the only
// thing it adds is a friendly page when the phone has no connection.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(
      '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Mindy’s Reader</title><body style="font-family:sans-serif;padding:40px 24px;text-align:center;color:#241f19;background:#e6e1fb">' +
      '<h2>You’re offline</h2><p>Mindy’s Reader needs an internet connection. Try again once you’re back online.</p></body>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )),
  );
});
