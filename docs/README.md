# nanonaBot Web ドキュメント

初めて使う方は [使い方ガイド](user-guide.md)、Toolforgeでの初回セットアップは [導入手順](DEPLOY_VERIFICATION.md) を参照してください。

## 目次

| 文書 | 内容 | 主な読者 |
|---|---|---|
| [一時停止・途中変更](task-controls.md) | 停止完了、対象追加・除外、設定編集、再開、DB更新手順 | 操作する人・運用者 |
| [全体ウェーブとpurge](global-waves.md) | ページを編集する順序、テンプレートの呼び出し先の更新、既存タスクとの互換性 | 操作する人・開発者 |
| [Bot作業の順番と動作詳解](bot-workflows.md)／[HTML版](bot-workflows.html) | 置換の構文、対象の抽出方法、複数のルールを組み合わせたときの処理順 | 操作する人・開発者 |
| [使い方ガイド](user-guide.md) | 各画面の見方と操作（ダッシュボード・タスク作成・確認・編集ログ・設定） | 操作する人 |
| [置換ルールの種類](rule-types.md) | 画面で選べる8種類のルールが何をどう書き換えるか、対象ページの集め方、例 | 操作する人 |
| [タスクの流れと各動作](task-lifecycle.md) | タスク・ページの状態、ウェーブ、承認、再試行、緊急停止、再開などの詳しい動き | 操作する人・運用者 |
| [Bot作業依頼（BOTREQ）](botreq.md) | `{{リンク修正依頼/改名}}` の各ペアがどのルールになるか、依頼の着手・完了・解決の記録 | 操作する人 |
| [PWA](pwa.md) | インストール・通信切断・更新の仕様と実機確認 | 操作する人・運用者 |
| [端末へのWeb Push](web-push.md) | PWAの端末通知・ログアウト連動・本番設定 | 操作する人・運用者 |
| [通知](notifications.md) | 端末通知・Webhook・メールの違い、通知イベントとテスト送信 | 操作する人・運用者 |
| [運用手順](operations.md) | 通常更新、再起動、権限一覧の変更、ログ・保持期間 | 運用者 |
| [設定（環境変数・DB）](configuration.md) | 環境変数の一覧と既定値、DBのテーブル | 運用者 |
| [API](api.md) | 画面が使っているHTTP APIの一覧 | 開発者 |
| [Toolforgeへの導入](DEPLOY_VERIFICATION.md) | 初回セットアップ、動作確認、トラブルシューティング | 運用者 |

## 全体像

```mermaid
flowchart LR
  browser[ブラウザ<br>（OOUIの画面）] -- HTTP --> web[Webサーバー<br>server.js]
  web -- 読み書き --> db[(ToolsDB)]
  worker[ワーカー<br>worker.js] -- 読み書き --> db
  worker -- 取得・編集<br>（BotPassword） --> wiki[ja.wikipedia.org<br>API]
  web -- 差分の取得・BOTREQ --> wiki
  web -. ログイン（OAuth 2.0） .-> meta[meta.wikimedia.org]
  web & worker -. 通知 .-> notify[Webhook / メール]
  web & worker -. 暗号化通知 .-> push[ブラウザ提供元のPushサービス]
  push -. Web Push .-> browser
```

- **Webサーバー**（`server.js`）は画面とAPIを提供します。タスクの作成・承認・却下・中止などはDBを通じてワーカーへ伝えます。Bot作業依頼の「保存」はWeb側からウィキへの編集・返信を行います。
- **ワーカー**（`worker.js`）はDBのキューからタスクを1件ずつ取り出し、対象ページの取得・置換・編集を行います。ワーカーは1プロセスで運用します。

## 権限

ログインには Wikimedia アカウント（OAuth 2.0）を使います。ログインしたアカウントの権限で、できることが変わります。

| 権限 | 対象 | できること |
|---|---|---|
| オーナー（`owner`） | `OWNER_USERNAMES` に含まれるアカウント（既定: `Nanona15dobato`・`なのな`） | すべての操作（タスク作成・承認・中止・緊急停止の解除・設定など） |
| 緊急停止のみ（`admin_emergency_only`） | `EMERGENCY_STOP_USERNAMES`（既定: `nanona15`）、`ADMIN_CHECK_WIKI_HOST`（既定: jawiki）の管理者（sysop）・拡張承認された利用者（extendedconfirmed） | 緊急停止だけ。タスクの内容は見られない |
| 権限なし（`denied`） | 上記以外 | 何もできない |

タスクによるウィキへの編集は、タスク作成時に選んだBotアカウント（`NanonaBot`・`NanonaBot3`・`Nanona15dobato`）のBotPasswordで行います。
