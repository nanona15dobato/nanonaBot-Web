/* nanonaBot Web: インストール・通信状態・更新。利用者データは端末に保存しない。 */
(function () {
  'use strict';

  const initialUser = window.NANONA_BOT || {};
  let needsAuthorization = true;
  let authorizationCheck = null;
  let pendingWrites = 0;
  let lastContact = null;
  let connectionError = false;
  let authorizationError = false;
  let uncertainWrite = false;
  let installPrompt = null;
  let registration = null;
  let updateRequested = false;
  let $status = null;
  let $update = null;
  let $install = null;

  function offline() { return navigator.onLine === false; }
  function isWrite(options) { return !['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase()); }
  function installed() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function renderStatus() {
    if (!$status) return;
    $status.hidden = !(offline() || connectionError || authorizationError || uncertainWrite);
    const text = $status.querySelector('span');
    const contact = lastContact ? ' 最終通信成功: ' + lastContact.toLocaleTimeString('ja-JP') + '。' : '';
    if (authorizationError) {
      text.textContent = 'ログイン状態または利用権限を確認できません。再接続後に画面を開き直してください。';
    } else if (uncertainWrite) {
      text.textContent = '操作結果を確認できません。再送する前にタスク一覧や対象画面で結果を確認してください。' + contact;
    } else {
      text.textContent = '接続できません。表示内容は最新とは限りません。サーバーの処理は続く場合があります。' + contact;
    }
  }

  function markFailure(write) {
    connectionError = true;
    needsAuthorization = true;
    if (write) uncertainWrite = true;
    renderStatus();
  }

  async function ensureAuthorization() {
    if (!needsAuthorization || !initialUser.username) return;
    if (!authorizationCheck) {
      authorizationCheck = (async () => {
        try {
          const response = await window.fetch('/api/whoami', { cache: 'no-store', credentials: 'same-origin' });
          const user = response.ok ? await response.json() : null;
          if (!user || user.username !== initialUser.username || user.role !== initialUser.role ||
              !['owner', 'admin_emergency_only'].includes(user.role)) {
            authorizationError = true;
            throw new Error('ログイン状態または利用権限が変わりました。画面を開き直してください。');
          }
          needsAuthorization = false;
          authorizationError = false;
          connectionError = false;
          renderStatus();
        } catch (error) {
          needsAuthorization = true;
          if (!authorizationError) markFailure(false);
          renderStatus();
          throw error;
        } finally {
          authorizationCheck = null;
        }
      })();
    }
    return authorizationCheck;
  }

  async function request(url, options, consume) {
    const opts = Object.assign({}, options, { cache: 'no-store' });
    const write = isWrite(opts);
    if (offline()) {
      markFailure(false);
      throw new Error('オフラインのため送信しませんでした。接続後にもう一度確認してください。');
    }
    if (write) {
      pendingWrites++;
      renderUpdate();
    }
    try {
      if (write) await ensureAuthorization();
      let response;
      try {
        response = await window.fetch(url, opts);
      } catch (cause) {
        markFailure(write);
        const error = new Error(write
          ? '操作結果を確認できません。再送する前に対象画面で結果を確認してください。'
          : 'サーバーに接続できません。表示内容は最新とは限りません。');
        error.resultUnknown = write;
        throw error;
      }
      if (response.status === 401 || response.status === 403 || response.status === 503) needsAuthorization = true;
      if (response.status === 401 || response.status === 403) authorizationError = true;
      if (response.ok) {
        lastContact = new Date();
        connectionError = false;
      }
      renderStatus();
      try {
        return consume ? await consume(response) : response;
      } catch (error) {
        if (error.resultUnknown) { uncertainWrite = true; renderStatus(); }
        throw error;
      }
    } finally {
      if (write) { pendingWrites--; renderUpdate(); }
    }
  }

  function button(label, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'nb-pwa-button';
    element.textContent = label;
    element.addEventListener('click', action);
    return element;
  }

  function renderUpdate() {
    if (!$update) return;
    $update.hidden = !(registration && registration.waiting && navigator.serviceWorker.controller);
    $update.querySelector('button').disabled = pendingWrites > 0;
  }

  function renderInstall() {
    if (!$install) return;
    $install.querySelector('button').hidden = installed() || !installPrompt;
    $install.querySelector('p').textContent = installed()
      ? 'アプリとして起動しています。'
      : 'ブラウザのメニューから「アプリをインストール」または「ホーム画面に追加」を選べます。iPhone・iPadでは共有メニューを確認してください。';
  }

  function createInstallPanel() {
    const panel = document.createElement('div');
    panel.className = 'nb-pwa-install';
    const help = document.createElement('p');
    const install = button('この端末にインストール', async () => {
      const prompt = installPrompt;
      if (!prompt) return;
      installPrompt = null;
      renderInstall();
      try { await prompt.prompt(); await prompt.userChoice; }
      catch (error) { help.textContent = 'ブラウザのメニューからインストールしてください。'; }
    });
    const version = document.createElement('small');
    version.textContent = 'アプリ版: 0.1.0-pwa.4';
    panel.append(help, install, version);
    $install = panel;
    renderInstall();
    return panel;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    renderInstall();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; renderInstall(); });
  window.addEventListener('offline', () => { needsAuthorization = true; renderStatus(); });
  window.addEventListener('online', () => {
    needsAuthorization = true;
    ensureAuthorization().catch(() => {});
    window.dispatchEvent(new Event('nb:reconnect'));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) needsAuthorization = true;
    else if (!offline()) {
      ensureAuthorization().catch(() => {});
      if (registration) registration.update().catch(() => {});
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) { needsAuthorization = true; renderStatus(); }
  });

  document.addEventListener('DOMContentLoaded', async () => {
    $status = document.createElement('div');
    $status.className = 'nb-pwa-status';
    $status.setAttribute('role', 'status');
    $status.append(document.createElement('span'), button('再接続する', () => window.location.reload()));
    const tasks = document.createElement('a');
    tasks.href = '/';
    tasks.textContent = 'タスク一覧で確認';
    if (initialUser.role === 'owner') $status.append(tasks);

    $update = document.createElement('div');
    $update.className = 'nb-pwa-update';
    $update.setAttribute('role', 'status');
    $update.hidden = true;
    const label = document.createElement('span');
    label.textContent = '新しいバージョンがあります。';
    $update.append(label, button('更新する', () => {
      if (pendingWrites || !registration || !registration.waiting) return;
      if (!window.confirm('画面を更新します。未保存の入力は失われます。更新しますか？')) return;
      updateRequested = true;
      registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    }));
    document.body.prepend($status, $update);
    document.querySelectorAll('[data-pwa-install]').forEach((element) => element.append(createInstallPanel()));
    renderStatus();

    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateRequested) window.location.reload();
    });
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
      renderUpdate();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (worker) worker.addEventListener('statechange', renderUpdate);
      });
    } catch (error) {
      // インストール機能の失敗で通常のWeb利用を妨げない。
    }
  }, { once: true });

  window.NanonaPwa = { request, createInstallPanel };
})();
