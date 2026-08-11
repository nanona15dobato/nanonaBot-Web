# NanonaBot Tool（フェーズ1）

Jawp編集支援Bot「NanonaBot Tool」のフェーズ1実装です。
含まれるもの:

- Wikimedia OAuth 2.0 ログイン
- 権限判定（`Nanona15dobato` = owner / sysop = admin_emergency_only / それ以外 = denied）
- 緊急停止API（誰でも停止可、解除はownerのみ）
- DBスキーマ（`tasks` / `task_pages` / `edit_log` / `system_status`）
- 最小ダッシュボード（プレースホルダーHTML。OOUIによる本実装はフェーズ3）
- `Template:リダイレクトの所属カテゴリ` の実際の書式を確認するスクリプト（`scripts/`）

含まれないもの（フェーズ2以降）: キュー/ワーカー、置換エンジン、BOTREQ連携、OOUI UI。

---

## 1. ローカルでの下準備

```bash
npm install
cp .env.example .env
# .env を編集: SESSION_SECRET、DB_*（ローカルにMySQL/MariaDBがあれば）等
npm test   # ユニットテスト（権限判定・replica.my.cnfパーサー等）
```

OAuthクライアントを作らなくても `npm test` は通ります（純粋関数のみをテストしているため）。
実際にログインを試す場合のみ、後述のOAuth登録が必要です。

## 2. Wikimedia OAuth 2.0 コンシューマの登録

1. `https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose` にアクセス（`Nanona15dobato` でログインした状態で）。
2. OAuth **2.0**、グラントタイプ **Authorization code** を選択。
3. コールバックURLに `https://<toolname>.toolforge.org/oauth/callback` を指定。
4. 発行された Client ID / Client Secret を控える（フェーズ1では追加のuser rights申請は不要。ユーザー名取得とグループ確認だけが目的のため）。

## 3. Toolforgeでのセットアップ

```bash
# Toolforge bastionにログイン後
become nanona-bot-tool   # ツール名は例。実際のツール名に読み替え

mkdir -p www/js
# このリポジトリの中身一式を ~/www/js にコピー（git cloneでもscpでも可）

cd www/js
```

### 3.1 依存パッケージのインストール

Node.jsのビルド環境が必要なコマンドは `webservice ... shell` の中で実行する。

```bash
webservice node20 shell
npm install
exit
```

### 3.2 ToolsDBの準備

```bash
sql tools
```

MariaDBプロンプトで（`<credentialUser>` は `$HOME/replica.my.cnf` の `user` の値。`SELECT CURRENT_USER();` 等で確認できる）:

```sql
CREATE DATABASE IF NOT EXISTS `<credentialUser>__nanona_bot`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
EXIT;
```

スキーマ流し込み:

```bash
mysql --defaults-file=$HOME/replica.my.cnf \
  -h tools.db.svc.wikimedia.cloud \
  <credentialUser>__nanona_bot < db/schema.sql
```

`.env` の `TOOLSDB_DATABASE_SUFFIX` を `nanona_bot` 以外にした場合は、上記のDB名もあわせて変更すること。

### 3.3 環境変数の設定

Toolforge本番では `.env` ファイルを置くのではなく、`toolforge envvars create` で1つずつ登録する（webservice・jobsどちらからも参照できる）。

```bash
toolforge envvars create OAUTH_CLIENT_ID
toolforge envvars create OAUTH_CLIENT_SECRET
toolforge envvars create OAUTH_CALLBACK_URL   # 例: https://nanona-bot-tool.toolforge.org/oauth/callback
toolforge envvars create OAUTH_WIKI_HOST      # meta.wikimedia.org
toolforge envvars create OWNER_USERNAME       # Nanona15dobato
toolforge envvars create ADMIN_CHECK_WIKI_HOST  # ja.wikipedia.org
toolforge envvars create SESSION_SECRET       # openssl rand -hex 32 等で生成
toolforge envvars create TOOL_BASE_URL        # 例: https://nanona-bot-tool.toolforge.org
toolforge envvars create TOOLSDB_DATABASE_SUFFIX  # nanona_bot
toolforge envvars create TASK_PAGES_RETENTION_DAYS  # 14
```

`toolforge envvars list` で登録済みの一覧を確認できる（値は伏字表示）。

### 3.4 Webサービスの起動

```bash
toolforge webservice node20 start
```

Kubernetesバックエンドでは `PORT` は常に8000固定で自動設定されるため、こちらで明示的に設定する必要はない。

停止・再起動・ログ確認:

```bash
toolforge webservice stop
toolforge webservice restart
toolforge webservice logs
```

### 3.5 動作確認

`https://<toolname>.toolforge.org/` にアクセスし、「Wikimediaアカウントでログイン」→ 認可 → コールバックでダッシュボードが表示されれば成功。

- `Nanona15dobato` でログイン: 「権限: owner」と表示され、緊急停止ボタンに加えて解除ボタンも見える。
- 管理者アカウントでログイン: 「権限: admin_emergency_only」、緊急停止ボタンのみ見える（解除ボタンは出ない）。
- それ以外のアカウント: 403で弾かれる。

## 4. `Template:リダイレクトの所属カテゴリ` の書式確認スクリプト

仕様書8章の「要確認事項」に対応。認証不要（公開情報の読み取りのみ）なので、Toolforge上・ローカルどちらでも実行できる。

```bash
# 実行前に scripts/check-redirect-category-template.js 内の
# WIKI_USER_AGENT を自分の連絡先に変更しておくこと
# （もしくは環境変数 WIKI_USER_AGENT で上書き）

WIKI_USER_AGENT="NanonaBotTool-Verification/0.1 (User:Nanona15dobato)" \
  node scripts/check-redirect-category-template.js
```

出力内容:

1. `Template:リダイレクトの所属カテゴリ` 自体のwikitext（`#invoke:` があればLuaモジュールも自動検出して取得）
2. `Template:リダイレクトの所属カテゴリ/doc` のwikitext
3. 実際にこのテンプレートを使っているページを数件取得し、`WikitextParser`（`lib/WikitextParser.js`）で実際の呼び出し部分を抽出・引数一覧を表示

実行結果は `redirect-category-template-report.json`（`--out <path>` で変更可）にも保存される。この出力を見て、仕様書8章「Category置換 Step4 / Category除去 Step2」の実装方針（引数の名前付け方・番号振り直しの要否など）を確定させる。

## 5. ディレクトリ構成

```
server.js                  エントリポイント
src/app.js                 Expressアプリ組み立て
src/config.js               環境変数の一元管理
src/db.js                   DB接続プール（replica.my.cnf優先）
src/db/replicaCnf.js        replica.my.cnfパーサー（純粋関数）
src/permissions.js          権限判定ロジック（純粋関数）
src/middleware/auth.js      認可ミドルウェア
src/routes/auth.js          OAuthログイン/コールバック/ログアウト
src/routes/emergency.js     緊急停止API
src/routes/dashboard.js     最小ダッシュボード（プレースホルダー）
lib/WikitextParser.js       Wikitext解析共有ライブラリ
scripts/check-redirect-category-template.js
                             Template:リダイレクトの所属カテゴリ 書式確認スクリプト
db/schema.sql               DBスキーマ
test/unit.test.js           ユニットテスト（`npm test`）
```

## 6. ライセンスについて

Toolforgeのポリシー上、公開するコードはOSI承認ライセンスを明示する必要がある。このリポジトリにはまだLICENSEファイルを含めていないので、MIT等お好みのライセンスを選定してLICENSEファイルを追加すること。

## 7. 次のフェーズ

フェーズ2（キュー/ワーカー基盤、`task_pages`によるページ単位の状態管理、1ページ先読みパイプライン）から続ける。
