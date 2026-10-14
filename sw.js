/* Soulrend service worker: offline play. Bump by rebuilding (version changes with content). */
const VERSION = 'c77a493bd7';
const CORE = ['./', 'index.html', 'three.min.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'fonts').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    e.respondWith(caches.match(r, {ignoreSearch: true}).then(hit => hit || fetch(r).then(res => { const cp = res.clone(); caches.open(VERSION).then(c => c.put(r, cp)); return res; }).catch(() => caches.match('index.html'))));
  } else if (/fonts\.(googleapis|gstatic)\.com/.test(u.host)) {
    e.respondWith(caches.open('fonts').then(c => c.match(r).then(hit => hit || fetch(r).then(res => { c.put(r, res.clone()); return res; }).catch(() => hit))));
  }
});
