'use strict';

// この一覧だけを保存する。認証済みHTML・API・OAuth・JS/CSSは保存しない。
const CACHE_PREFIX = 'nanonabot-pwa-';
const CACHE_NAME = CACHE_PREFIX + 'v1';
const OFFLINE_URL = '/static/offline.html';
const PUBLIC_FILES = [
  OFFLINE_URL,
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/icon-maskable-512.png',
  '/static/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(
    PUBLIC_FILES.map((url) => new Request(url, { credentials: 'omit', cache: 'reload' }))
  )));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // UIで更新を選択したときにだけ待機中の版を有効にする。
  if (event.data && event.data.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (PUBLIC_FILES.includes(url.pathname) && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(url.pathname)) || fetch(request);
    })());
    return;
  }

  // 認証用URLには介入しない。エラー応答をオフライン画面に置き換えない。
  if (request.mode === 'navigate' && !url.pathname.startsWith('/oauth/') && !url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(OFFLINE_URL)) || Response.error();
    }));
  }
});
