# NanonaBot Tool（フェーズ1-2）

Jawp編集支援Bot「NanonaBot Tool」のフェーズ1・フェーズ2実装です。

**Toolforge上の配置場所**: このリポジトリの実体は `$HOME/nanonaBot-Web` に置く。
Node.js webserviceの規約上必須の `$HOME/www/js` は、そこへのシンボリックリンクとして
運用する（詳細は3章）。ワーカー（`worker.js`）もこのディレクトリを起点に起動する。

含まれるもの:

**フェーズ1**
- Wikimedia OAuth 2.0 ログイン
- 権限判定（`Nanona15dobato` = owner / sysop = admin_emergency_only / それ以外 = denied）
- 緊急停止API（誰でも停止可、解除はownerのみ）
- DBスキーマ（`tasks` / `task_pages` / `edit_log` / `system_status`）
- 最小ダッシュボード（プレースホルダーHTML。OOUIによる本実装はフェーズ3）
- `Template:リダイレクトの所属カテゴリ` の実際の書式を確認するスクリプト（`scripts/`）

**フェーズ2（今回追加）**
- MediaWiki Botクライアント（`src/bot/`）: Special:BotPasswords方式のログイン、
  ページ取得、`basetimestamp`/`starttimestamp`を使った編集競合検出つきの編集。
  外部ライブラリ（mwn等）を使わず、MediaWiki公式ドキュメント（API:Login, API:Edit）の
  手順をそのまま実装（正確性を検証しやすくするため）
- 正規表現の複数ステップ置換エンジン（`src/worker/regexEngine.js`、
  `WikitextParser.protectRegions`で`<nowiki>`等を保護。仕様書6章）
- キュー（`src/worker/queue.js`、1キュー1タスクをアトミックにclaim）
- **1ページ先読みパイプライン**（`src/worker/pipeline.js`、仕様書9.2節）:
  「Aを確認している間にBを裏で準備する」方式で、対象ページを1件ずつ
  準備→Diff確認待ち→編集していく。`onFailure`（pause/skipAndContinue）、
  緊急停止、manualモードのタイムアウトにも対応
- `edit_log`への即時書き込み（仕様書9.4節）
- タスク作成・進捗確認・承認/却下・再開の最小JSON API（`src/routes/tasks.js`）
- ワーカーのエントリポイント `worker.js`（Toolforge continuous job用）

**含まれないもの（フェーズ3以降）**: OOUIによる本UI、`manualList`以外の対象ページ取得方法
（category/backlinks/embeddedin/regexSearch/botreqDerived）、BOTREQ連携、
リンク置換の2ウェーブ構成、Category系の`warningSource`。

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

Toolforgeの`$HOME`直下には他のツール設定等が既にある想定なので、このリポジトリの実体は
`$HOME/nanonaBot-Web` に置き、Node.js webserviceの規約上必須の `$HOME/www/js` は
そこへの**シンボリックリンク**にする。

> Toolforgeの`toolforge webservice`（Node.js）は「設定より規約」で動作し、
> `$HOME/www/js/package.json` の存在と、`$HOME/www/js` で `npm start` が
> 動くこと（`$HOME/www/js/server.js` があれば自動的にそれが使われる）を
> 前提にしている。このパス自体は変更できないため、実体を別ディレクトリに置いて
> `www/js` からシンボリックリンクを張るのが定石。`require()`等の相対パス解決は
> シンボリックリンク越しでも問題なく動く。

```bash
# Toolforge bastionにログイン後
become <toolname>   # 実際のツール名に読み替え（例: nanonabot-web）

mkdir -p ~/nanonaBot-Web
# このリポジトリの中身一式を ~/nanonaBot-Web にコピー（git cloneでもscpでも可）

# www/js を nanonaBot-Web へのシンボリックリンクにする
mkdir -p ~/www
# 既にwww/jsが存在する場合（空ディレクトリ等）は先に退避・削除しておく
#   例: rmdir ~/www/js   もしくは   mv ~/www/js ~/www/js.bak
ln -s ~/nanonaBot-Web ~/www/js

# 確認: シンボリックリンク経由でpackage.jsonが見えること
ls -la ~/www/js
cat ~/www/js/package.json | head -3
```

以降の`npm install`等はどちらのパスからでも同じ実体を触る（`cd ~/www/js`しても
`cd ~/nanonaBot-Web`しても中身は同じ）。本READMEでは以後 `~/nanonaBot-Web` 側の
パスで統一して記載する。

```bash
cd ~/nanonaBot-Web
```

### 3.1 依存パッケージのインストール

Node.jsのビルド環境が必要なコマンドは `webservice ... shell` の中で実行する。
シェルに入った直後のカレントディレクトリは`$HOME`なので、`cd`してから実行する。

```bash
webservice node20 shell
cd ~/nanonaBot-Web   # または cd www/js でも同じ実体
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

スキーマ流し込み（`~/nanonaBot-Web` で実行する。それ以外の場所からなら`db/schema.sql`を`~/nanonaBot-Web/db/schema.sql`に読み替え）:

```bash
cd ~/nanonaBot-Web
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
toolforge envvars create OAUTH_CALLBACK_URL   # 例: https://<toolname>.toolforge.org/oauth/callback
toolforge envvars create OAUTH_WIKI_HOST      # meta.wikimedia.org
toolforge envvars create OWNER_USERNAME       # Nanona15dobato
toolforge envvars create ADMIN_CHECK_WIKI_HOST  # ja.wikipedia.org
toolforge envvars create SESSION_SECRET       # openssl rand -hex 32 等で生成
toolforge envvars create TOOL_BASE_URL        # 例: https://<toolname>.toolforge.org
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

### 3.5 OAuthログインの動作確認

`https://<toolname>.toolforge.org/` にアクセスし、「Wikimediaアカウントでログイン」→ 認可 → コールバックでダッシュボードが表示されれば成功。

- `Nanona15dobato` でログイン: 「権限: owner」と表示され、緊急停止ボタンに加えて解除ボタンも見える。
- 管理者アカウントでログイン: 「権限: admin_emergency_only」、緊急停止ボタンのみ見える（解除ボタンは出ない）。
- それ以外のアカウント: 403で弾かれる。

### 3.6 ワーカーの起動（フェーズ2）

編集を実際に行うワーカーはWebサービスとは別プロセスで、continuous jobとして常駐させる。
jobsフレームワークのコマンドは`$HOME`をカレントディレクトリとして実行されるため、
`~/nanonaBot-Web`へ明示的に`cd`してから起動する。

```bash
toolforge jobs run nanona-bot-worker \
  --command "bash -c 'cd ~/nanonaBot-Web && node worker.js'" \
  --image node20 \
  --continuous
```

追加で必要な環境変数（Botアカウント3種のBotPassword。`Special:BotPasswords`で発行）:

```bash
toolforge envvars create BOT_NANONA15DOBATO_USER   # 例: Nanona15dobato@toolname
toolforge envvars create BOT_NANONA15DOBATO_PASS
toolforge envvars create BOT_NANONABOT_USER        # 例: NanonaBot@toolname
toolforge envvars create BOT_NANONABOT_PASS
toolforge envvars create BOT_NANONABOT3_USER       # 例: NanonaBot3@toolname
toolforge envvars create BOT_NANONABOT3_PASS
toolforge envvars create WIKI_API_URL              # 既定: https://ja.wikipedia.org/w/api.php
```

ログ確認・停止:

```bash
toolforge jobs logs nanona-bot-worker
toolforge jobs delete nanona-bot-worker
```

Toolforgeのcontinuous job枠（webservice含めて既定3つまで）を消費する点に注意。
Webサービス1 + ワーカー1で2つ使う。将来のクリーンアップジョブ（9.4節）は
`--schedule`指定のcronジョブとして別枠で動かすため、continuous枠は消費しない。

### 3.7 動作確認（curlでタスクを作成・承認してみる）

Web UI（OOUI）はフェーズ3で実装するため、フェーズ2時点ではJSON APIを直接叩いて確認する。
`Nanona15dobato`でログイン済みのブラウザからセッションCookieを取得し、以下のように使う
（`nanona_bot_sid=...`はブラウザの開発者ツールで確認したセッションCookieの値に置き換える）。

**必ず`利用者:Nanona15dobato/sandbox`のような実害のないページで試すこと。**

```bash
COOKIE="nanona_bot_sid=xxxxxxxx"
BASE="https://<toolname>.toolforge.org"

# タスク作成
curl -s -X POST "$BASE/api/tasks" \
  -H "Content-Type: application/json" \
  -b "$COOKIE" \
  -d '{
    "account": "NanonaBot",
    "replacements": [{
      "templateType": "custom",
      "steps": [{ "pattern": "テスト前", "flags": "g", "replacement": "テスト後" }],
      "targetSource": { "type": "manualList", "titles": ["利用者:Nanona15dobato/sandbox"] }
    }],
    "editSettings": {
      "botFlag": false,
      "minorEdit": true,
      "editSummary": "Bot: フェーズ2動作確認",
      "editIntervalSeconds": 10
    },
    "reviewSettings": { "mode": "manual", "manualTimeoutHours": 1 },
    "onFailure": "pause"
  }'
# => {"id": 1}

# タスク一覧・進捗確認
curl -s "$BASE/api/tasks" -b "$COOKIE"

# ページ一覧（status: pending → preparing → prepared → awaiting_review → ...）
curl -s "$BASE/api/tasks/1/pages" -b "$COOKIE"

# Diff確認（本文込み）
curl -s "$BASE/api/tasks/1/pages/1/diff" -b "$COOKIE"

# 承認（awaiting_reviewのページにだけ効く）
curl -s -X POST "$BASE/api/tasks/1/pages/1/approve" -b "$COOKIE"

# 却下
curl -s -X POST "$BASE/api/tasks/1/pages/1/reject" -b "$COOKIE"

# onFailure="pause"で止まったタスクの再開
curl -s -X POST "$BASE/api/tasks/1/resume" -b "$COOKIE"
```

## 4. `Template:リダイレクトの所属カテゴリ` の書式確認スクリプト

仕様書8章の「要確認事項」に対応。認証不要（公開情報の読み取りのみ）なので、Toolforge上・ローカルどちらでも実行できる。

```bash
# ~/nanonaBot-Web で実行する
cd ~/nanonaBot-Web

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
server.js                   Webサービスのエントリポイント
worker.js                   ワーカーのエントリポイント（フェーズ2）
src/app.js                  Expressアプリ組み立て
src/config.js                環境変数の一元管理
src/db.js                    DB接続プール（replica.my.cnf優先）
src/db/replicaCnf.js         replica.my.cnfパーサー（純粋関数）
src/dbJson.js                 JSON列のパース/シリアライズ・ユーティリティ
src/permissions.js           権限判定ロジック（純粋関数）
src/middleware/auth.js       認可ミドルウェア
src/routes/auth.js           OAuthログイン/コールバック/ログアウト
src/routes/emergency.js      緊急停止API
src/routes/tasks.js          タスク作成・進捗確認・承認/却下/再開API（フェーズ2）
src/routes/dashboard.js      最小ダッシュボード（プレースホルダー）
src/bot/mwClient.js          MediaWiki Botクライアント（生fetch実装。ログイン/取得/編集）
src/bot/cookieJar.js         ログインセッション保持用の簡易CookieJar
src/bot/mwUtil.js            タイムスタンプ変換等の純粋関数
src/bot/accountNames.js      Botアカウント名の静的定義（依存ゼロ、taskConfig.jsから直接利用）
src/bot/accounts.js          アカウント名→ログイン済みクライアントのキャッシュ
src/worker/regexEngine.js    正規表現の複数ステップ置換エンジン
src/worker/taskConfig.js     タスクconfig_jsonのバリデーション（純粋関数）
src/worker/queue.js          キューからのアトミックなタスクclaim
src/worker/pipeline.js       1ページ先読みパイプライン本体（仕様書9.2節）
src/worker/taskRunner.js     対象列挙→task_pages投入→パイプライン実行のオーケストレーション
src/worker/emergencyStop.js  緊急停止フラグ確認
src/worker/editLog.js        edit_logへの書き込み
lib/WikitextParser.js        Wikitext解析共有ライブラリ
scripts/check-redirect-category-template.js
                              Template:リダイレクトの所属カテゴリ 書式確認スクリプト
db/schema.sql                DBスキーマ
test/unit.test.js            権限判定・replica.my.cnfパーサー等のユニットテスト
test/worker.test.js          置換エンジン・タスクconfig検証・JSON列ユーティリティのテスト
test/bot.test.js             MediaWikiBotClientのテスト（fetchをモックし、ログイン〜編集の
                              一連の流れとbasetimestamp伝播を検証）
test/pipeline.test.js        1ページ先読みパイプラインの統合テスト（DBをインメモリスタブ化）
```

`npm test` で全テスト（`node --test`）を実行できる。

## 6. 既知の制約（フェーズ2時点）

- 対象ページ取得は `targetSource.type: "manualList"` のみ対応。`category`/`backlinks`/
  `embeddedin`/`regexSearch`/`botreqDerived`はフェーズ4で追加する。
- リンク置換の2ウェーブ構成（Template名前空間→再取得→その他ページ）、Category系の
  `warningSource`（リダイレクトの所属カテゴリ警告）は未実装（フェーズ4）。
- ワーカーがクラッシュ/再起動した場合、処理中だった1ページ分の状態（`preparing`/
  `editing`のまま止まったページ）は自動復旧しない。手動で該当`task_pages`行の
  ステータスを`pending`に戻すか、タスクごと作り直す必要がある（将来的な改善候補）。
- OAuthアクセストークンはセッションに保存していない（2章参照）ため、フェーズ2の
  編集はすべてBotPasswordアカウント経由のみ。操作者自身の権限で行う操作が
  将来必要になった場合は別途設計する。
- テストはユニットテスト＋fetch/DBをモックした統合テストのみで、実際のToolforge/
  ToolsDB/Wikipedia本番環境に対する動作確認は行っていない。3.7節の手順で
  Sandboxページに対して実際に確認すること。

## 7. ライセンスについて

Toolforgeのポリシー上、公開するコードはOSI承認ライセンスを明示する必要がある。このリポジトリにはまだLICENSEファイルを含めていないので、MIT等お好みのライセンスを選定してLICENSEファイルを追加すること。

## 8. 次のフェーズ

フェーズ3（Diff確認フロー全体のOOUI本実装、失敗時挙動のUI、タイムアウトのUI表示）。
