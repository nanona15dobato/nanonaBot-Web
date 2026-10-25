# 設定（環境変数・DB）

Toolforge では `toolforge envvars create 名前` を実行し、対話入力で値を登録・更新します。ローカル開発では `.env` に書きます（`.env.example` を参照）。Webサーバーとワーカーは同じ環境変数を読みます。値を変えたら、Webサービスとワーカーのジョブを再起動してください。

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
| `NODE_ENV` | （なし） | `production` のとき、セッションCookieに `Secure` を付ける。本番HTTPS環境では設定する |

### 既存セッションの権限失効

Webアプリは、ログイン時だけでなく、ログイン済みの各API・ページ要求の前に権限を再判定します。セッションに保存された以前の `role` は、そのまま認可に使用しません。

- `OWNER_USERNAMES` / `EMERGENCY_STOP_USERNAMES` を変更したら、Webサービスを再起動してください。owner変更時はPushの送信対象にも反映するためワーカーも再起動します。環境変数はプロセス起動時に読み込まれるため、登録変更だけでは稼働中プロセスに反映されません。変更後の全Webプロセスで、既存セッションにも次の要求から新しい一覧を適用します。
- 明示一覧にない利用者は、`ADMIN_CHECK_WIKI_HOST` の公開グループ情報を要求ごとに取得します。`sysop` / `extendedconfirmed` の削除は、次の権限確認で反映します。権限のキャッシュは使用しません。
- owner一覧から外れても、別の緊急停止一覧やWikiグループの条件を満たす利用者には、緊急停止専用の権限が残ります。すべての操作権限を外すには、適用される許可経路をすべて確認してください。
- グループ照会は5秒で打ち切ります。通信失敗・不正応答の場合は、以前の権限を使わず `503 authorization_unavailable` で要求を止めます。復旧後は次の要求で再確認します。明示的に許可されたowner・緊急停止利用者はグループ照会に依存しません。
- ログイン開始・OAuthコールバック・ログアウトは、グループ照会障害中も利用できます。すでに認可を終えた処理や実行中のBotタスクを、この仕組みで中断することはありません。必要な場合は別途タスクの中止・緊急停止を使ってください。

### ブラウザーへの埋め込み制限

Webアプリは全応答に `Content-Security-Policy: frame-ancestors 'none'` と `X-Frame-Options: DENY` を付け、同一オリジンも含むiframe等への埋め込みを禁止します。通常のトップレベル表示や、PWAの独立ウィンドウ表示とは両立します。埋め込みを必要とする運用へ変更する場合は、このポリシーも見直してください。

この強制CSPは埋め込み制限だけを指定します。Toolforge側の `Content-Security-Policy-Report-Only` と併存し、スクリプト・スタイルの読み込み元制限やPWA機能を追加するものではありません。HSTSはToolforge側の設定を使用します。

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
| `BOTREQ_ACCOUNT` | `Nanona15dobato` | 依頼ページの編集（解決）と依頼への返信に使うアカウント（`BOT_<名前>_USER` / `_PASS` で BotPassword を設定したもの）。BotPassword には「既存ページの編集」「ページの作成・編集・移動」の権限が必要。一覧などの読み取りはログインせずに行う |
| `BOTREQ_LOG_ACCOUNT` | （作業記録の利用者空間の持ち主。既定では `NanonaBot`） | 作業記録の編集に使うアカウント。jawiki では他人の利用者ページの編集に `editalluserpages` が要り、この権限は BotPassword では付けられないため、作業記録のページがある利用者空間の持ち主で編集する |
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

新規環境は `db/schema.sql` で作ります。`CREATE TABLE IF NOT EXISTS` は不足テーブルを追加しますが、既存テーブルの列や索引は変更しません。既存環境の更新時は、変更内容と `db/migrations/` の対象SQLを確認してください。Push追加時は `db/migrations/20261025_push.sql` を使います。

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
| `push_subscriptions` | 端末のPush購読・購読鍵・ユーザー・セッション・選択イベント・期限。内容を調査出力へ貼り付けない |


## PWAの端末通知

| 名前 | 既定値 | 説明 |
|---|---|---|
| `VAPID_SUBJECT` | （なし） | 運用者の連絡先を示す `mailto:` またはHTTPS URL |
| `VAPID_PUBLIC_KEY` | （なし） | VAPID公開鍵 |
| `VAPID_PRIVATE_KEY` | （なし） | 同じペアの秘密鍵。共有・ログ出力しない |

3つをWebとワーカーに設定します。未設定時は端末通知だけを無効にします。秘密鍵は公開しません。設定手順、追加テーブル、端末での有効化は [端末へのWeb Push](web-push.md) を参照してください。既存のメール／Webhookとは独立して通知対象を選びます。
