// Minimal service worker — required for "Add to Home Screen"
// installability and for push notifications. It deliberately does NOT
// intercept fetches.
//
// It previously had:
//   self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
// which looks harmless but is actively harmful: it hijacks every single
// request, re-issues it, and adds nothing. Any momentary failure — most
// commonly during a deploy, when the server is briefly restarting —
// became a hard "no internet" error instead of the browser's normal
// retry behaviour. That's why reinstalling the PWA "fixed" it: it
// cleared the worker that was breaking things.
//
// With no fetch handler, the browser handles networking natively,
// including its own retry and error pages. Install and push still work.

self.addEventListener('install', () => {
  // Take over immediately rather than waiting for every tab to close,
  // so a new deploy's worker replaces the old one on next load.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Real push delivery — this is what makes a notification arrive on the
// device even when no HandyLink tab is open.
self.addEventListener('push', (event) => {
  let data = { title: 'HandyLink', body: '', url: '/' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (err) { /* fall back to the defaults above */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/images/icon-192.png',
      badge: '/images/icon-192.png',
      data: { url: data.url }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.endsWith(targetUrl) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
