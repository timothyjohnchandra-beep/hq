// Network first for the app itself; cached copy when offline or slow. Data calls are never cached.
const CACHE = 'hq-v18';
const SHELL = ['./', './index.html', './reader.js', './fonts/reader.css', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE && x !== 'hq-books').map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google calls go straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await Promise.race([fetch(e.request), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
      if (net && net.ok) cache.put(e.request, net.clone());
      return net;
    } catch (err) {
      return (await cache.match(e.request)) || (await cache.match('./index.html')) || Response.error();
    }
  })());
});
