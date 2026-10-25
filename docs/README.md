# NanonaBot Tool ドキュメント

日本語版ウィキペディアの編集支援Bot「NanonaBot Tool」の利用者向け・運用者向けの説明です。
導入手順や開発の経緯はリポジトリ直下の [README](../README.md) を参照してください。

## 目次

| 文書 | 内容 | 主な読者 |
|---|---|---|
| [使い方ガイド](user-guide.md) | 各画面の見方と操作（ダッシュボード・タスク作成・確認・編集ログ・設定） | 操作する人 |
| [置換ルールの種類](rule-types.md) | 9種類のルールが何をどう書き換えるか、対象ページの集め方、例 | 操作する人 |
| [タスクの流れと各動作](task-lifecycle.md) | タスク・ページの状態、ウェーブ、承認、再試行、緊急停止、再開などの詳しい動き | 操作する人・運用者 |
| [Bot作業依頼（BOTREQ）](botreq.md) | `{{リンク修正依頼/改名}}` の各ペアがどのルールになるか、依頼の着手・完了・解決の記録 | 操作する人 |
| [PWA](pwa.md) | インストール・通信切断・更新の仕様と実機確認 | 操作する人・運用者 |
| [端末へのWeb Push](web-push.md) | PWAの端末通知・ログアウト連動・本番設定 | 操作する人・運用者 |
| [通知](notifications.md) | Webhook・メール通知の設定とテスト送信 | 運用者 |
| [設定（環境変数・DB）](configuration.md) | 環境変数の一覧と既定値、DBのテーブル | 運用者 |
| [API](api.md) | 画面が使っているHTTP APIの一覧 | 開発者 |
| [実環境デプロイ・動作確認 手順書](DEPLOY_VERIFICATION.md) | Toolforgeへの配置から動作確認・トラブルシューティングまで | 運用者 |

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
```

- **Webサーバー**（`server.js`）は画面とAPIを提供します。タスクの作成・承認・却下・中止などはDBを書き換えるだけで、ウィキへの編集は行いません。
- **ワーカー**（`worker.js`）はDBのキューからタスクを1件ずつ取り出し、対象ページの取得・置換・編集を行います。常に1つだけ動かす前提です（同時に2つ動かさない）。
- 画面とワーカーはDBを通してやり取りします。画面で承認すると、ワーカーが最大0.5秒以内（既定）にそれを読み取って編集します。

## 権限

ログインには Wikimedia アカウント（OAuth 2.0）を使います。ログインしたアカウントの権限で、できることが変わります。

| 権限 | 対象 | できること |
|---|---|---|
| オーナー（`owner`） | `OWNER_USERNAMES` に含まれるアカウント（既定: `Nanona15dobato`・`なのな`） | すべての操作（タスク作成・承認・中止・緊急停止の解除・設定など） |
| 緊急停止のみ（`admin_emergency_only`） | `EMERGENCY_STOP_USERNAMES`（既定: `nanona15`）、jawikiの管理者（sysop）・拡張承認された利用者（extendedconfirmed） | 緊急停止だけ。タスクの内容は見られない |
| 権限なし（`denied`） | 上記以外 | 何もできない |

ウィキへの編集は、操作した人のアカウントではなく、タスク作成時に選んだBotアカウント（`NanonaBot`・`NanonaBot3`・`Nanona15dobato`）のBotPasswordで行います。
