# 設定（環境変数・DB）

Toolforge では `toolforge envvars create 名前 値` で登録します。ローカル開発では `.env` に書きます（`.env.example` を参照）。Webサーバーとワーカーは同じ環境変数を読みます。値を変えたら、Webサービスとワーカーのジョブを再起動してください。

## 環境変数

### 必須（Webサーバー）

| 名前 | 説明 |
|---|---|
| `OAUTH_CLIENT_ID` | meta.wikimedia.org で登録した OAuth 2.0 コンシューマの Client ID |
| `OAUTH_CLIENT_SECRET` | 同 Client Secret |
| `SESSION_SECRET` | セッションの署名用の秘密の文字列（32文字以上を推奨。`openssl rand -hex 32` 等） |

ワーカーはこれらが無くても動きます。

### Botアカウント（ワーカー）

Special:BotPasswords で発行したログイン名（`User@BotName` 形式）とパスワードです。使うアカウントの分だけ設定します。

| アカウント | ログイン名 | パスワード |
|---|---|---|
| `NanonaBot` | `BOT_NANONABOT_USER` | `BOT_NANONABOT_PASS` |
| `NanonaBot3` | `BOT_NANONABOT3_USER` | `BOT_NANONABOT3_PASS` |
| `Nanona15dobato` | `BOT_NANONA15DOBATO_USER` | `BOT_NANONA15DOBATO_PASS` |

### サーバー・ログイン・権限

| 名前 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `8000` | 待ち受けポート（Toolforgeでは自動設定） |
| `TOOL_BASE_URL` | `http://localhost:8000` | ツールのURL（`https://ツール名.toolforge.org`）。OAuthのコールバックと通知のリンクに使う |
| `OAUTH_CALLBACK_URL` | `TOOL_BASE_URL` + `/oauth/callback` | OAuthのコールバックURL（コンシューマ登録時と完全一致させる） |
| `OAUTH_WIKI_HOST` | `meta.wikimedia.org` | OAuthの認可に使うホスト |
| `OWNER_USERNAMES` | `OWNER_USERNAME`,`なのな` | オーナー（全操作）にするアカウント（カンマ区切り） |
| `OWNER_USERNAME` | `Nanona15dobato` | 旧設定。`OWNER_USERNAMES` が無いときに使う |
| `EMERGENCY_STOP_USERNAMES` | `nanona15` | 緊急停止だけ許可するアカウント（カンマ区切り） |
| `ADMIN_CHECK_WIKI_HOST` | `ja.wikipedia.org` | 管理者・拡張承認の判定に使うウィキ |
| `NODE_ENV` | （なし） | `production` のとき、セッションCookieに `Secure` を付ける（HTTPSで運用するなら設定を推奨） |

### ウィキ

| 名前 | 既定値 | 説明 |
|---|---|---|
| `WIKI_API_URL` | `https://ja.wikipedia.org/w/api.php` | 編集・取得の対象ウィキのAPI |
| `WIKI_USER_AGENT` | `NanonaBotTool/0.1 (Toolforge; https://ja.wikipedia.org/wiki/User:Nanona15dobato)` | APIへのリクエストに付けるUser-Agent |

### ワーカーの動き

このうち `REVIEW_POLL_INTERVAL_MS`・`EDIT_RETRY_COUNT`・`EDIT_RETRY_BASE_MS`・`NULL_EDIT_INTERVAL_MS`・`TASK_PAGES_RETENTION_DAYS` は、**設定画面の「ワーカーの動作」から再起動せずに変更できます**。画面で保存した値は環境変数より優先され、ワーカーには最大30秒で反映されます（値の決まり方: 画面の設定 → 環境変数 → 既定値）。

| 名前 | 既定値 | 説明 |
|---|---|---|
| `WORKER_POLL_INTERVAL_MS` | `1000` | キューに新しいタスクが無いか確認する間隔 |
| `REVIEW_POLL_INTERVAL_MS` | `500` | 承認待ちの間、承認・却下されたか確認する間隔（画面で承認してから編集が始まるまでの最大の遅れ） |
| `EDIT_RETRY_COUNT` | `3` | 一時的な失敗の再試行回数 → [編集の失敗と再試行](task-lifecycle.md#編集の失敗と再試行) |
| `EDIT_RETRY_BASE_MS` | `10000` | 1回目の再試行までの待ち時間（2回目以降は倍々） |
| `NULL_EDIT_INTERVAL_MS` | `1000` | null edit 1件（purgeは1バッチ）ごとの間隔 |
| `RATE_LIMIT_WAIT_MS` | `60000` | purge がレート制限に当たったときに待つ時間 |
| `TASK_PAGES_RETENTION_DAYS` | `14` | 終わったタスクのページ単位の作業データ（`task_pages`）を残す日数。`0` で削除しない → [作業データの自動削除](task-lifecycle.md#作業データの自動削除) |
| `CLEANUP_INTERVAL_MS` | `3600000`（1時間） | 作業データの削除を実行する間隔（ワーカーの起動時と、その後この間隔ごとにタスクの合間で実行） |

### 通知

[通知](notifications.md) を参照してください。設定画面で保存した値はこちらより優先されます。

| 名前 | 既定値 | 説明 |
|---|---|---|
| `NOTIFY_WEBHOOK_URL` | （なし） | Slack / Discord の Webhook URL |
| `NOTIFY_MAIL_TO` | （なし） | メールの宛先（カンマ区切り） |
| `NOTIFY_MAIL_FROM` | （なし） | メールの送信元（`ツール名.任意@toolforge.org` 形式） |
| `NOTIFY_EVENTS` | （すべて） | 通知する出来事（カンマ区切り） |
| `SMTP_HOST` | `mail.tools.wmcloud.org` | メール送信に使うSMTPサーバー |
| `SMTP_PORT` | `25` | 同ポート |

### Bot作業依頼

[着手・完了・解決](botreq.md#着手完了解決フェーズ13) で使います。

| 名前 | 既定値 | 説明 |
|---|---|---|
| `BOTREQ_ACCOUNT` | `Nanona15dobato` | 作業記録の編集と依頼への返信に使うアカウント（`BOT_<名前>_USER` / `_PASS` で BotPassword を設定したもの） |
| `BOTREQ_BOT_USER` | `nanonaBot` | 作業の編集回数・投稿記録を数える Bot |
| `BOTREQ_OPERATOR` | `nanona15dobato` | 作業記録のページを新しく作るときの `{{../head|運用者=}}` |
| `BOTREQ_LOG_PREFIX` | `利用者:nanonaBot/依頼/` | 作業記録のページ名（後ろに「YYYY年」が付く） |

### データベース

| 名前 | 既定値 | 説明 |
|---|---|---|
| `REPLICA_MY_CNF_PATH` | `$HOME/replica.my.cnf` | ToolsDBの認証情報ファイル（Toolforgeでは自動で置かれる） |
| `TOOLSDB_DATABASE_SUFFIX` | `nanona_bot` | DB名 `<ユーザー>__<この値>` の後ろの部分 |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | （なし）/ `3306` | ローカル開発用。`replica.my.cnf` が無いときだけ使う |

## DBのテーブル

`db/schema.sql` で作ります。すべて `CREATE TABLE IF NOT EXISTS` なので、新しいバージョンにしたときは同じファイルをもう一度流し込めば、足りないテーブルだけが追加されます。

| テーブル | 内容 |
|---|---|
| `system_status` | 緊急停止の状態（1行だけ） |
| `tasks` | タスク（設定・状態・進捗・ウェーブ・null editの進み具合など） |
| `task_pages` | タスクごとの対象ページと、準備した本文・状態 |
| `edit_log` | 実際の編集の最終結果（恒久ログ。本文は含まない） |
| `task_logs` | タスクの実行ログ・操作の記録 |
| `task_warnings` | Category系の要手動確認の警告 |
| `bot_account_defaults` | Botアカウントごとの編集設定・実行モードの既定値 |
| `app_settings` | 画面から変更した運用設定（通知先・ワーカーの動作）と、ワーカーの稼働状況（`worker.heartbeat`） |
| `sessions` | ログインセッション（`express-mysql-session` が自動で作る） |
