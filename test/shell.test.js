'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderShell, renderStaticPage, staticButtonHtml } = require('../src/views/shell');

test('renderShell: OOUIの日本語メッセージとウィキのホスト名を埋め込む', () => {
  const html = renderShell({ title: 'タスク #1', script: 'taskDetail.js', initialData: { username: 'A', role: 'owner', taskId: 1 } });
  const messages = JSON.parse(html.match(/Object\.assign\(OO\.ui\.msg\.messages, (\{.*?\})\);<\/script>/s)[1]);
  assert.equal(messages['ooui-dialog-message-reject'], 'キャンセル');
  assert.equal(messages['@metadata'], undefined);
  const data = JSON.parse(html.match(/window\.NANONA_BOT = (\{.*?\});/)[1]);
  assert.equal(data.wikiHost, 'ja.wikipedia.org');
  assert.equal(data.taskId, 1);
  assert.match(html, /oojs-ui-wikimediaui-icons-interactions\.min\.css/);
});

test('renderShell: 初期データ・タイトルの </script> や HTML をエスケープする', () => {
  const html = renderShell({ title: '<b>x</b>', script: 'dashboard.js', initialData: { username: '</script><script>alert(1)</script>' } });
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('<title>&lt;b&gt;x&lt;/b&gt; - nanonaBot Web</title>'));
});

test('renderStaticPage/staticButtonHtml: OOUIのボタンの見た目のリンクと送信ボタンを作る', () => {
  const link = staticButtonHtml({ label: 'ログイン', href: '/oauth/login', primary: true });
  assert.match(link, /oo-ui-buttonWidget/);
  assert.match(link, /oo-ui-flaggedElement-primary/);
  assert.match(link, /<a class="oo-ui-buttonElement-button" role="button" href="\/oauth\/login">/);
  assert.match(staticButtonHtml({ label: 'ログアウト' }), /<button type="submit"/);
  const page = renderStaticPage({ title: 'ログイン', bodyHtml: link });
  assert.match(page, /<main class="nb-login">/);
});
