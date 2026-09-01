// Mom's Care — service worker
// Handles incoming push notifications and lets tapping one open/focus the app.
// This file must sit in the SAME folder as index.html on the server.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "It's medicine time", body: event.data ? event.data.text() : '' };
  }

  const title = data.title || "It's medicine time";
  const options = {
    body: data.body || '',
    tag: data.tag || 'momscare-alarm',
    renotify: true,
    requireInteraction: true,
    vibrate: [300, 150, 300, 150, 300],
    data: { url: data.url || './' }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
