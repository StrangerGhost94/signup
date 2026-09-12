// Minimal service worker — required for "Add to Home Screen" installability
// on Android/Chrome. Does not cache anything; just passes requests through
// (deliberately — see the app's own explanation of why nothing is cached).
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
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
