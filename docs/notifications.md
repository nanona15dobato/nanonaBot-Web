# 通知

運用上の重要な出来事を、端末へのWeb Push、Webhook（Slack / Discord）、メールで知らせます。

| 経路 | 設定場所 | テスト |
|---|---|---|
| [端末へのWeb Push](web-push.md) | 設定画面「この端末への通知」。端末・ログインごとに有効化 | 「この端末へテスト通知」 |
| Webhook・メール | 設定画面の通知先、または環境変数。運用全体に適用 | 「テスト送信」 |

以下は主にWebhook・メールの設定です。どちらも設定しなければ、この2経路には通知しません。PWAの端末通知は独立した設定です。通知の送信に失敗しても、緊急停止やタスクの処理は止まりません（タイムアウト5秒、失敗はサーバーのログに残ります）。

## 通知する出来事

| 種類（メール／Webhookの `NOTIFY_EVENTS`、端末側のイベント選択） | いつ |
|---|---|
| `emergency_stop` | 緊急停止が実行された |
| `emergency_clear` | 緊急停止が解除された |
| `paused` | タスクが失敗により一時停止した |
| `failed` | タスクがエラーで終了した |
| `expired` | タスクが無操作タイムアウトで期限切れになった |
| `emergency_stopped` | タスクが緊急停止で中断した |
| `completed_with_failures` | タスクが完了した（失敗ページあり） |
| `completed` | タスクが完了した |

端末通知の既定は `completed` を除く7種類、メール／Webhookは絞り込み未設定なら全種類です。`NOTIFY_EVENTS` は端末通知に影響しません。

中止（キャンセル）は通知しません。タスク通知は対象タスクへのリンク、緊急停止・解除はホームへのリンクを付けます（`TOOL_BASE_URL` を基準にします）。

## 設定方法

設定は **設定画面**（`/settings`、オーナー専用）か **環境変数** で行います。画面で保存した項目は環境変数より優先されます。

| 項目 | 設定画面 | 環境変数 |
|---|---|---|
| Webhook URL | Webhook URL（Slack / Discord） | `NOTIFY_WEBHOOK_URL` |
| メールの宛先（カンマ区切り） | メールの宛先 | `NOTIFY_MAIL_TO` |
| メールの送信元 | メールの送信元 | `NOTIFY_MAIL_FROM` |
| 通知する出来事 | 通知する出来事（チェックボックス） | `NOTIFY_EVENTS`（カンマ区切り。空ならすべて） |

- 設定画面の各項目の横に、今の値の出どころ（画面で設定／環境変数／未設定）が出ます。「環境変数の値に戻す」で、画面で保存した値を消せます。
- 画面の設定は DB の `app_settings` テーブルに保存されます。テーブルが無い場合（`db/schema.sql` を流し込み直していない）は、環境変数だけで動きます。
- ワーカーは画面の設定を30秒キャッシュするため、保存から反映まで最大30秒かかります。

## Webhook

- Slack の Incoming Webhook、Discord の Webhook のURLをそのまま使えます（`https://` で始まるURLのみ）。
- 本文は `{"text": …, "content": …}` の形でPOSTします（Slackは `text`、Discordは `content` を読みます）。約1900文字を超える分は切ります（Discordの上限2000文字に収めるため）。

## メール（Toolforge）

Toolforge のメールサーバー `mail.tools.wmcloud.org:25` 経由で送ります（[Help:Toolforge/Email](https://wikitech.wikimedia.org/wiki/Help:Toolforge/Email)）。

- **送信元**は `ツール名.任意の文字列@toolforge.org` の形式にする必要があります。例: `"nanonaBotWeb:Error" <nanonabot01.weberror@toolforge.org>`（ツール名が `nanonabot01` の場合）。
- **宛先**の `利用者名@toolforge.org` は、idm.wikimedia.org の開発者アカウントに登録したメールアドレスへ転送されます。
- 宛先と送信元の両方が設定されているときだけメールを送ります。
- Toolforge のメールサーバーには、アドレスごとの送信数の上限があります。完了通知が多すぎる場合は「タスクが完了した」を外してください。
- 件名は `[NanonaBot Tool] タスク #12 がエラーで終了しました` の形です。

## テスト送信

設定画面の「テスト送信」は、**保存済みの設定**で各通知先にテスト通知を送ります。通知する出来事の絞り込みに関係なく送り、Webhook とメールそれぞれの結果（送信しました／失敗しました／未設定）を表示します。

## PWAの端末通知

[端末へのWeb Push](web-push.md) は設定画面で端末ごとに有効化します。上記のメール／Webhookとは独立した通知対象を選びます。従来の「テスト送信」はメール／Webhookだけに送り、端末へのテストは専用ボタンから行います。
