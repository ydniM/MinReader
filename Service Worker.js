// Lets Chrome install the reader as an app. It doesn't save anything for
// offline use. It makes sure the page is always the newest version, and
// shows a friendly page when there's no connection.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    // Always asks GitHub whether the page changed, instead of reusing a copy up to 10 minutes old.
    fetch(event.request.url, { cache: 'no-cache', credentials: 'same-origin' }).catch(() => new Response(
      '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Mindy’s Reader</title><body style="font-family:sans-serif;padding:40px 24px;text-align:center;color:#241f19;background:#e6e1fb">' +
      '<h2>You’re offline</h2><p>Mindy’s Reader needs an internet connection. Try again once you’re back online.</p></body>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )),
  );
});
