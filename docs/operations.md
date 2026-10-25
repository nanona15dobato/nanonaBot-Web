# 運用手順

初回導入は [デプロイ手順](DEPLOY_VERIFICATION.md)、端末通知の初回設定は [Web Push](web-push.md) を参照してください。ここでは稼働中の `~/nanonaBot-Web` を更新します。コマンド中の `node20` は現在の配備で使用しているイメージ名です。ランタイムを変更する場合はWebとワーカーの双方で依存関係・動作を検証してください。

## 通常更新

1. 設定画面でワーカーの稼働状況を確認し、実行中の編集が落ち着いてから更新します。再起動中に編集結果が不明になったページは履歴で照合してください。
2. bastionでツールアカウントになり、取得するコミットとローカル差分を確認します。

   ```bash
   cd ~/nanonaBot-Web
   git status --short
   git pull --ff-only origin main
   git log -1 --oneline
   ```

   差分や分岐で更新が止まったら、その内容を確認します。本番にだけある `package-lock.json` や `core` を消して進めないでください。
3. 依存関係の変更がある場合だけ、Node環境でインストールします。

   ```bash
   toolforge webservice node20 shell
   cd ~/nanonaBot-Web
   npm install --ignore-scripts --omit=dev --no-audit --no-fund
   exit
   ```

   本リポジトリには追跡済みlockfileがありません。生成・更新された本番のlockfileは別途差分を確認・保管します。`npm ci` はそのまま代用できません。
4. DB変更がある場合はリリースの対象マイグレーションを確認して適用します。ToolsDBでは `SELECT DATABASE();` で選択先を確認してください。Pushテーブルの追加済み環境で、鍵を再生成する必要はありません。
5. アプリのコード・環境変数の変更はWebとワーカーの両方へ反映します。Webの再起動だけではワーカーの読み込み済みコードは更新されません。

   ```bash
   toolforge webservice node20 restart
   toolforge jobs restart nanona-bot-worker
   toolforge webservice status
   toolforge jobs list
   ```

6. 画面を開き、PWAの更新案内があれば適用します。設定画面の稼働状況と端末通知のテスト受信を確認します。ドキュメントだけの更新には再起動や購読の再登録は不要です。

`jobs list` の「Running for」だけではPodの再作成時刻を判断できない場合があります。再起動時刻を調べる場合は次を使います。

```bash
kubectl get pods -o custom-columns='NAME:.metadata.name,STARTED:.status.containerStatuses[*].state.running.startedAt,STATUS:.status.phase'
```

## 環境変数と権限一覧の変更

bastionではアプリ用変数が空でも、Web／ジョブには設定されている場合があります。実効値は `toolforge webservice node20 shell` 内で確認します。秘密鍵やパスワードを含む環境変数の一括表示は避けてください。

緊急停止を許可する明示一覧を確認する場合:

```bash
toolforge webservice node20 shell
cd ~/nanonaBot-Web
node -e 'console.log(require("./src/config").permissions.emergencyStopUsernames.join("\n"))'
exit
```

追加・変更はbastionで次を実行し、既存ユーザーを含むカンマ区切りの一覧を入力します。入力は追記ではなく全体の置き換えです。

```bash
toolforge envvars create EMERGENCY_STOP_USERNAMES
toolforge webservice node20 restart
```

明示一覧とは別に `ADMIN_CHECK_WIKI_HOST` の `sysop`・`extendedconfirmed` も緊急停止できます。owner判定が優先され、解除はownerだけです。owner一覧の変更時はPushの送信対象にも反映するためワーカーも再起動します。既存セッションの扱いは [権限失効](configuration.md#既存セッションの権限失効) を参照してください。

環境変数の更新にも `create` を使用し、値はプロンプトに入力します。画面で保存した通知・ワーカー設定は環境変数より優先され、最大30秒でワーカーに反映されます。この操作には再起動は不要です。

## PWA通知の確認

1. 設定の「この端末への通知」で有効状態と対象イベントを確認します。通常の完了は既定では選択されません。
2. 「この端末へテスト通知」で実受信を確認します。メール／Webhookの「テスト送信」とは別です。
3. イベント通知の確認には、選択したイベントが実際に発生する必要があります。テスト通知の受信だけでは、ワーカーからのイベント通知まで検証したことにはなりません。
4. 文面がすべて「確認が必要なイベントがあります」のままなら、Webとワーカーの再起動、端末のPWA更新を確認します。文面変更だけなら鍵の再生成や購読の再登録は不要です。
5. ログアウト・セッション期限切れ・鍵変更後は、ログインしてこの端末の通知を明示的に有効化します。

## ログと保持期間

- ワーカーのログ確認: `toolforge jobs logs nanona-bot-worker`。ファイルログを使う配備では `toolforge jobs show nanona-bot-worker` で実際の保存先を確認します。
- この配備のファイルログは `$HOME/nanona-bot-worker.out` と `$HOME/nanona-bot-worker.err`。2026-10-25にモード `0640` を確認しました。ログの再作成後も所有者・グループ・モードを確認します。
- 現在の運用選択はファイルログを無期限保持・自動ローテーション未設定です。`stat` 等で容量を確認し、削除・ローテーションを導入する場合は別途保持方針を決めます。
- `task_pages` の保持期間とファイルログの保持期間は別です。コードの既定は14日、この配備では作業データの保持日数を30日に設定する運用を選択しました。現在値は設定画面で確認します。`edit_log` はこのクリーンアップの対象外です。
- `core` はクラッシュダンプの可能性があります。認証情報を含み得るため、内容を公開・共有せず、保管・削除は用途を確認して行います。

## 本番での確認記録（2026-10-25）

以下は運用者から共有された結果です。すべてのブラウザ・端末を確認したという意味ではありません。

- `NODE_ENV=production`、HTTPSのベースURLとOAuthコールバック一致を確認。
- `Content-Security-Policy: frame-ancestors 'none'`、`X-Frame-Options: DENY` と通常表示を確認。
- Web Push依存関係、追加テーブル、VAPID設定の有効判定、Web／ワーカーの新Pod起動、端末へのテスト通知受信を確認。
- イベント別文面への更新手順は運用者が完了と報告。各イベントの実配送・全端末での表示は個別に確認する。
- iPhone/iPadのSafari実機、メール実配送、ログ再作成後の権限は確認結果をまだ記録していない。

参考: [Toolforgeの環境変数](https://wikitech.wikimedia.org/wiki/Help:Toolforge/Envvars#Updating_an_environment_variable)、[ジョブの再起動](https://wikitech.wikimedia.org/wiki/Help:Toolforge/Running_jobs#Restarting_your_jobs)、[Webサービス](https://wikitech.wikimedia.org/wiki/Help:Toolforge/Web)。
