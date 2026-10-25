// Service worker: offline shell cache + push notifications.
const CACHE = 'nbac-v2';
const SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/store.js', './js/scoring.js', './js/cup.js', './js/teams.js', './lib/feeds.js', './config.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// Network first, fall back to cache (so updates show up right away, and the app still opens offline).
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
self.addEventListener('push', (e) => {
  let data = {}; try { data = e.data.json(); } catch { data = { title: 'NBA Challenge', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'NBA Challenge', {
    body: data.body || '', icon: './icons/icon-192.png', badge: './icons/badge-72.png', tag: data.tag || 'nbac', renotify: !!data.tag,
    data: { url: data.url || './index.html#slate' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './index.html#slate', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.location.origin) && 'focus' in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
