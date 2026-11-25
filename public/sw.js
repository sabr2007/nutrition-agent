/* Рядом — service worker: offline shell, cached Today data, web push. */
// The deploy's version (D30): /sw-version.js changes with every deploy → a new worker installs,
// drops the old caches and takes over; the page reloads once.
try { importScripts('/sw-version.js'); } catch { /* offline install: keep the fallback */ }
const VERSION = self.SW_VERSION || 'v3';
const SHELL = `shell-${VERSION}`;
const STATIC = `static-${VERSION}`;
const DATA = `data-${VERSION}`;
const SHELL_URLS = ['/', '/body', '/more', '/login', '/offline'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => Promise.allSettled(SHELL_URLS.map((u) => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, STATIC, DATA].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Static build assets: cache-first (they are content-hashed).
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.open(STATIC).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
    return;
  }
  // Today snapshot: network-first, fall back to the last good copy when offline.
  if (url.pathname === '/api/today') {
    event.respondWith(fetch(req).then((res) => { if (res.ok) caches.open(DATA).then((c) => c.put(url.pathname + url.search, res.clone())); return res; })
      .catch(() => caches.open(DATA).then((c) => c.match(url.pathname + url.search)).then((r) => r || new Response(JSON.stringify({ error: { message: 'offline', code: 'offline' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  // Navigations: network-first with cached shell fallback.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => { if (res.ok) caches.open(SHELL).then((c) => c.put(url.pathname, res.clone())); return res; })
      .catch(async () => (await caches.match(url.pathname, { ignoreSearch: true })) || (await caches.match('/')) || (await caches.match('/offline'))));
  }
});

// iOS requires that every push results in a visible notification.
self.addEventListener('push', (event) => {
  let raw = {};
  try { raw = event.data ? event.data.json() : {}; } catch { raw = { title: 'Рядом', body: event.data ? event.data.text() : '' }; }
  // Declarative Web Push shape ({web_push: 8030, notification: {...}}) or legacy flat shape.
  const n = raw.notification || raw;
  const title = n.title || 'Рядом';
  const url = (n.data && n.data.url) || n.url || '/';
  event.waitUntil(self.registration.showNotification(title, {
    body: n.body || '',
    tag: n.tag || undefined,
    lang: 'ru',
    icon: '/icons/192',
    badge: '/icons/192',
    data: { url, id: (n.data && n.data.id) || n.id || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, id } = event.notification.data || {};
  const target = new URL(url || '/', self.location.origin);
  if (id) target.searchParams.set('n', id);
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); if ('navigate' in c) await c.navigate(target.href); return; }
    }
    await self.clients.openWindow(target.href);
  })());
});
