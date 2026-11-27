# nanonaBot Web

日本語版ウィキペディアの編集支援Botをブラウザーから操作するWebアプリです。改名に伴うリンクの修正やカテゴリの整理など、複数ページにわたる編集をタスクとして管理できます。

- リンク・カテゴリ・テンプレートの置換や除去、外部リンクの付け替え、正規表現による置換
- 編集前の差分確認と承認・却下、タスクの一時停止・再開、緊急停止
- [Wikipedia:Bot作業依頼](https://ja.wikipedia.org/wiki/Wikipedia:Bot作業依頼)からの置換ルールの取り込みと、依頼の着手・完了・解決の記録
- 編集履歴の確認、失敗したページの再試行、タスク単位での一括取り消し
- PWAのインストールと端末ごとのWeb Push通知。Webhookとメールにも対応

Wikimediaアカウントでログインします。タスクの作成・承認はオーナーが行い、別途設定した利用者やウィキ上の権限に応じて緊急停止を許可できます。

## ドキュメント

- **使う** — [使い方ガイド](docs/user-guide.md)、[置換ルール](docs/rule-types.md)、[一時停止・再開と途中の変更](docs/task-controls.md)
- **導入・運用する** — [Toolforgeへの導入](docs/DEPLOY_VERIFICATION.md)、[運用手順](docs/operations.md)、[設定](docs/configuration.md)
- **実装を調べる** — [タスクの流れ](docs/task-lifecycle.md)、[Bot作業の処理順](docs/bot-workflows.md)、[HTTP API](docs/api.md)

[ドキュメント一覧](docs/README.md)

## 開発

Node.js 20以上が必要です。

```sh
npm install
npm test
```

テストはOAuthの認証情報やデータベースへの接続なしで実行できます。Webアプリとワーカーを動かすには、[`.env.example`](.env.example) を `.env` にコピーして構成に合わせて設定し、[`db/schema.sql`](db/schema.sql) でMySQLまたはMariaDBを初期化します。ログインにはWikimedia OAuthの設定、Botとして編集を試すには使用するアカウントのBotパスワードが必要です。 [環境変数とデータベースの設定](docs/configuration.md)

```sh
npm run dev
```

ワーカーは別の端末で `npm run worker` を実行して起動します。

| パス | 内容 |
| --- | --- |
| `server.js`、`src/routes/`、`src/views/` | Webサーバー、HTTP API、画面 |
| `worker.js`、`src/worker/` | タスクのキュー、対象ページの取得、置換処理 |
| `src/bot/` | MediaWiki APIクライアント |
| `db/` | データベースのスキーマとマイグレーション |

## ライセンス

[GNU General Public License v3.0](LICENSE)
