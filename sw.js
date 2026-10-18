/* Cache application files only. Never cache Google APIs, OAuth responses, or user backups. */
const VERSION = '1.0.1';
const PREFIX = `bbt-gd:${new URL(self.registration.scope).pathname}:`;
const CACHE = `${PREFIX}${VERSION}`;
const ASSETS = ['index.html', 'styles.css', 'app.js', 'core.js', 'db.js', 'drive.js', 'manifest.webmanifest', 'icon.svg', 'icon-192-v101.png', 'icon-512-v101.png', 'icon-maskable-512-v101.png', 'apple-touch-icon-v101.png'];
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await cache.addAll(ASSETS.map(path => new Request(new URL(path, self.registration.scope), { cache: 'reload' })));
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE') self.skipWaiting();
  if (event.data?.type === 'VERSION') event.ports?.[0]?.postMessage({ version: VERSION });
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const base = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const relative = url.pathname.slice(base.pathname.length);
  if (relative === 'version.json' || relative === 'sw.js') return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(new URL('index.html', self.registration.scope).href);
      return cached || fetch(event.request);
    })());
  } else if (ASSETS.includes(relative)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(new URL(relative, self.registration.scope).href)) || fetch(event.request);
    })());
  }
});
