/* 端末ごとのWeb Push。購読情報をlocalStorage等に保存しない。 */
(function () {
  'use strict';
  const LABELS = {
    emergency_stop: '緊急停止', emergency_clear: '緊急停止の解除', paused: 'タスクの一時停止',
    failed: 'タスクの失敗', expired: '期限切れ', emergency_stopped: '緊急停止による中断',
    completed_with_failures: '一部失敗を含む完了', completed: 'タスクの完了',
  };
  const api = (url, options) => window.NanonaCommon.fetchJson(url, options);
  const supported = () => window.isSecureContext && typeof window.Notification !== 'undefined' && typeof window.PushManager !== 'undefined' && 'serviceWorker' in navigator;

  function within(promise, ms, message) {
    let timer;
    return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
      .finally(() => clearTimeout(timer));
  }
  function publicKey(value) {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  async function endpointHash(subscription) {
    const bytes = new TextEncoder().encode(subscription.endpoint);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function capabilities(registration) {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const finish = (value) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(value); };
      const timer = setTimeout(() => finish(false), 1500);
      channel.port1.onmessage = (event) => finish(Boolean(event.data && event.data.version >= 2));
      if (!registration.active) return finish(false);
      registration.active.postMessage({ type: 'PUSH_CAPABILITIES' }, [channel.port2]);
    });
  }
  function makeButton(label, className, fn) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nb-pwa-button ' + className;
    button.textContent = label;
    button.addEventListener('click', fn);
    return button;
  }

  function mount(root) {
    const notice = document.createElement('p');
    notice.setAttribute('role', 'status');
    const fields = document.createElement('fieldset');
    fields.className = 'nb-push-events';
    const legend = document.createElement('legend');
    legend.textContent = 'この端末に通知する出来事';
    fields.append(legend);
    const choices = new Map();
    for (const [event, label] of Object.entries(LABELS)) {
      const line = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = event;
      line.append(input, document.createTextNode(' ' + label));
      fields.append(line);
      choices.set(event, input);
    }
    let config = null;
    let registration = null;
    let subscription = null;
    let active = false;
    let ready = false;
    let busy = false;
    const selected = () => [...choices].filter(([, input]) => input.checked).map(([event]) => event);
    const json = (method, body) => ({ method, body: JSON.stringify(body) });

    function renderButtons() {
      enable.hidden = active;
      disable.hidden = !active;
      enable.disabled = busy || !ready || (window.Notification && window.Notification.permission === 'denied');
      disable.disabled = busy || !ready;
      save.disabled = test.disabled = busy || !ready || !active;
      refresh.disabled = busy;
      fields.disabled = busy || !ready;
    }
    async function run(fn) {
      if (busy) return;
      busy = true;
      renderButtons();
      try { await fn(); }
      catch (error) { notice.textContent = error.message || '端末通知を設定できませんでした。'; }
      finally { busy = false; renderButtons(); }
    }
    async function load() {
      ready = false;
      active = false;
      notice.textContent = '通知の状態を確認しています…';
      renderButtons();
      if (!supported()) {
        notice.textContent = 'このブラウザでは端末通知を利用できません。iPhone・iPadではホーム画面に追加したアプリから開いてください。';
        return;
      }
      config = await api('/api/push/config');
      if (!config.configured) { notice.textContent = 'サーバーの端末通知はまだ設定されていません。'; return; }
      registration = await within(navigator.serviceWorker.ready, 5000, 'アプリの準備を確認できません。再読み込みしてお試しください。');
      if (!(await capabilities(registration))) {
        notice.textContent = '端末通知を使うにはアプリの更新が必要です。更新の案内から更新して、もう一度確認してください。';
        return;
      }
      subscription = await registration.pushManager.getSubscription();
      const status = subscription ? await api('/api/push/subscription?endpointHash=' + await endpointHash(subscription)) : { registered: false };
      active = Boolean(status.registered && window.Notification.permission === 'granted');
      for (const [event, input] of choices) input.checked = (status.registered ? status.events : config.defaultEvents).includes(event);
      ready = true;
      notice.textContent = window.Notification.permission === 'denied'
        ? 'ブラウザで通知が拒否されています。ブラウザのサイト設定で許可してから、状態を確認してください。'
        : active ? 'この端末への通知は有効です。ログアウトまたはログイン期限切れで停止します。' : 'この端末への通知は無効です。';
      renderButtons();
    }
    const enable = makeButton('この端末で通知を受け取る', 'nb-push-enable', () => run(async () => {
      // ユーザーのクリックから直接許可を求める。画面表示時には求めない。
      const permission = await window.Notification.requestPermission();
      if (permission !== 'granted') { notice.textContent = '通知は許可されていません。'; return; }
      let current = await registration.pushManager.getSubscription();
      const key = publicKey(config.publicKey);
      const existingKey = current && current.options && current.options.applicationServerKey;
      if (current && (!existingKey || Array.from(new Uint8Array(existingKey)).join(',') !== Array.from(key).join(','))) {
        await current.unsubscribe();
        current = null;
      }
      if (!current) current = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      subscription = current;
      await api('/api/push/subscription', json('POST', { subscription: current.toJSON(), events: selected(), publicKey: config.publicKey }));
      await load();
    }));
    const disable = makeButton('この端末の通知を停止', 'nb-push-disable', () => run(async () => {
      let serverRemoved = false;
      let browserRemoved = false;
      try {
        await api('/api/push/subscription', json('DELETE', { endpointHash: await endpointHash(subscription) }));
        serverRemoved = true;
      } catch { /* ブラウザ側でも解除を試す */ }
      try { browserRemoved = await within(subscription.unsubscribe(), 5000, '通知の解除を確認できません。'); } catch { /* 下で結果を表示 */ }
      if (!serverRemoved && !browserRemoved) throw new Error('通知の停止を確認できません。接続を確認して再度お試しください。');
      const notifications = await registration.getNotifications();
      notifications.forEach((notification) => notification.close());
      active = false;
      notice.textContent = 'この端末の通知を停止しました。送信済みの通知が遅れて届く場合があります。';
    }));
    const save = makeButton('通知する出来事を保存', 'nb-push-save', () => run(async () => {
      await api('/api/push/subscription', json('PUT', { endpointHash: await endpointHash(subscription), events: selected() }));
      notice.textContent = 'この端末の通知設定を保存しました。';
    }));
    const test = makeButton('この端末へテスト通知', 'nb-push-test', () => run(async () => {
      const result = await api('/api/push/test', json('POST', { endpointHash: await endpointHash(subscription) }));
      notice.textContent = result.accepted ? '通知サービスへ送信しました。端末の表示をご確認ください。' : '通知サービスへの送信を確認できませんでした。状態を確認してお試しください。';
    }));
    const refresh = makeButton('状態を確認', 'nb-push-refresh', () => run(load));
    const actions = document.createElement('div');
    actions.className = 'nb-form-actions';
    actions.append(enable, disable, save, test, refresh);
    root.append(notice, fields, actions);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (!busy) run(load); });
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'PUSH_SUBSCRIPTION_CHANGED') {
          ready = false;
          notice.textContent = '端末の通知購読が変わりました。「状態を確認」から再登録してください。';
          renderButtons();
        }
      });
    }
    run(load);
  }

  async function cleanupBrowser() {
    if (!('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration) return;
    const operations = [registration.getNotifications().then((items) => items.forEach((item) => item.close()))];
    if (registration.pushManager) operations.push(registration.pushManager.getSubscription().then((subscription) => subscription && subscription.unsubscribe()));
    await Promise.allSettled(operations);
  }
  const loggingOut = new WeakSet();
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
    const url = new URL(form.action, window.location.href);
    if (url.origin !== window.location.origin || url.pathname !== '/oauth/logout') return;
    event.preventDefault();
    if (loggingOut.has(form)) return;
    loggingOut.add(form);
    // ブラウザの解除が失敗・停滞しても、サーバーのログアウトを実行する。
    within(cleanupBrowser(), 1000, 'logout').catch(() => {}).finally(() => {
      // OOUIのポップアップが閉じてフォームがDOMから外れていても送信する。
      if (!form.isConnected) { form.hidden = true; document.body.append(form); }
      HTMLFormElement.prototype.submit.call(form);
    });
  }, true);

  window.NanonaPush = { mount, cleanupBrowser };
})();
