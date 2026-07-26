/* =====================================================================
 * AEGIS MIRROR — Service Worker (PWA offline shell)
 * =====================================================================
 * Strategy:
 *   - HTML navigation requests  → network-first, fall back to cached /
 *     so users always see the wizard, even offline.
 *   - Static assets             → cache-first, refresh in background.
 *   - /api/* requests           → never cached; engine is the source
 *     of truth.
 * ===================================================================== */

const CACHE_VERSION = 'aegis-v1.0.0';
const SHELL_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/src/styles/aegis.css',
    '/src/lib/wizard.js',
    '/icon-192.png',
    '/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    // Drop any older caches so a stale shell doesn't serve after a deploy.
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
        ).then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // API requests: never cache.
    if (url.pathname.startsWith('/api/')) {
        return; // let the browser hit the network
    }

    // Navigation requests: network-first.
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE_VERSION).then((cache) => cache.put('/', copy));
                return res;
            }).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
        );
        return;
    }

    // Static assets: cache-first.
    event.respondWith(
        caches.match(req).then((cached) =>
            cached || fetch(req).then((res) => {
                const copy = res.clone();
                caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
                return res;
            }),
        ),
    );
});