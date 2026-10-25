'use strict';

// この一覧だけを保存する。認証済みHTML・API・OAuth・JS/CSSは保存しない。
const CACHE_PREFIX = 'nanonabot-pwa-';
const CACHE_NAME = CACHE_PREFIX + 'v4';
const OFFLINE_URL = '/static/offline.html';
const PUBLIC_FILES = [
  OFFLINE_URL,
  '/static/icons/favicon-192.png',
  '/static/icons/bot-favicon.png',
  '/static/icons/icon-maskable-512.png',
  '/static/icons/favicon-180.png',
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
  if (event.data && event.data.type === 'PUSH_CAPABILITIES' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: 2 });
  }
});

function notificationPath(value) {
  return typeof value === 'string' && (value === '/settings' || /^\/tasks\/[1-9]\d*$/.test(value)) ? value : '/';
}

const EVENT_NOTICES = {
  emergency_stop: ['緊急停止', 'Botの緊急停止が実行されました。'],
  emergency_clear: ['緊急停止解除', 'Botの緊急停止が解除されました。'],
  paused: ['タスク一時停止', 'タスクが一時停止しました。アプリで状態を確認してください。'],
  failed: ['タスク失敗', 'タスクがエラーで終了しました。アプリで詳細を確認してください。'],
  expired: ['タスク期限切れ', 'タスクが無操作タイムアウトで期限切れになりました。'],
  emergency_stopped: ['タスク中断', '緊急停止によりタスクが中断しました。'],
  completed_with_failures: ['タスク完了（一部失敗）', 'タスクが完了しました。失敗したページがあります。'],
  completed: ['タスク完了', 'タスクが完了しました。'],
  test: ['テスト通知', 'これは端末通知のテストです。通知を受信できています。'],
};

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* 汎用通知へフォールバック */ }
  if (!data || typeof data !== 'object') data = {};
  const notice = typeof data.event === 'string' && Object.prototype.hasOwnProperty.call(EVENT_NOTICES, data.event)
    ? EVENT_NOTICES[data.event] : null;
  // ページ名・利用者名・エラー本文をロック画面に出さない。
  event.waitUntil(self.registration.showNotification(notice ? 'nanonaBot Web：' + notice[0] : 'nanonaBot Web', {
    body: notice ? notice[1] : '確認が必要なイベントがあります。アプリを開いて確認してください。',
    icon: '/static/icons/favicon-192.png', badge: '/static/icons/favicon-192.png',
    tag: typeof data.tag === 'string' && /^nanona-[a-f0-9]{24}$/.test(data.tag) ? data.tag : 'nanona-event',
    data: { url: notificationPath(data.url) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = notificationPath(event.notification.data && event.notification.data.url);
  // 既存タブの未保存入力を書き換えず、通常の認証付き画面へ移動する。
  event.waitUntil(self.clients.openWindow(new URL(target, self.location.origin).href));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  // ログイン状態が不明なバックグラウンドでは自動再購読しない。
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) client.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' });
  }));
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
