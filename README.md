# NanonaBot Tool（フェーズ1-7）

Jawp編集支援Bot「NanonaBot Tool」のフェーズ1〜5実装です。

**実環境で最初から最後まで確認したい場合**は、本READMEより先に
[`docs/DEPLOY_VERIFICATION.md`](docs/DEPLOY_VERIFICATION.md) のチェックリストに沿って進めることを推奨する
（コード転送→OAuth登録→Botパスワード発行→DB→環境変数→起動→ブラウザでの確認まで一本道）。
本READMEは各手順の背景説明・リファレンスとして使う。

**Toolforge上の配置場所**: このリポジトリの実体は `$HOME/nanonaBot-Web` に置く。
Node.js webserviceの規約上必須の `$HOME/www/js` は、そこへのシンボリックリンクとして
運用する（詳細は3章）。ワーカー（`worker.js`）もこのディレクトリを起点に起動する。

含まれるもの:

**フェーズ1**
- Wikimedia OAuth 2.0 ログイン
- 権限判定（`Nanona15dobato`・`なのな` = owner / sysop・拡張承認利用者・`nanona15` = admin_emergency_only / それ以外 = denied）
- 緊急停止API（owner・admin_emergency_onlyが停止可、解除はownerのみ）
- ワーカーの待機間隔は `WORKER_POLL_INTERVAL_MS`、レビュー状態の確認間隔は
  `REVIEW_POLL_INTERVAL_MS` で調整できる（既定値はいずれも1秒）。
- Botアカウントごとの編集設定・実行モードのデフォルトは、タスク作成画面の
  「このアカウントのデフォルトとして保存」から `bot_account_defaults` に保存できる。
- DBスキーマ（`tasks` / `task_pages` / `edit_log` / `task_logs` / `task_warnings` / `system_status`）
- `Template:リダイレクトの所属カテゴリ` の実際の書式を確認するスクリプト（`scripts/`）

**フェーズ2**
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

**フェーズ3**
- OOUIによる本UI（`public/js/`）。npm公式の標準的な組み込み方法
  （jQuery + OOjs + OOUI本体 + wikimediauiテーマを`/vendor/`配下で静的配信）に準拠
- ダッシュボード（`/`）: システム状態・タスク一覧・緊急停止。`admin_emergency_only`は
  緊急停止パネルのみ表示（仕様書2章の原則どおり、他は一切見えない）
- タスク作成画面（`/tasks/new`）・タスク詳細/Diff確認画面（`/tasks/:id`）
- `GET /api/tasks/:id/pages/:pageId/compare`（`action=compare`のtoslots/totext-main
  形式によるDiff HTML取得。MCR対応の現行の正しい書き方）

**フェーズ4**
- **テンプレート機能5種類**（`src/worker/templatePresets.js`、仕様書6章）:
  リンク置換／リンク置換2／Category置換／Category除去／テンプレート置換を、
  from/toの入力だけで実際に動くsteps配列として自動生成する。
  **原案にあったハットノート系正規表現の構文バグ（先頭の開き括弧欠落）を修正済み**
  （修正はNanonaBotToolの仕様書側にも反映済み）
- **対象ページ自動取得4種類**（`src/worker/targetResolvers.js`）: category/backlinks/
  embeddedin/regexSearch。いずれも継続パラメータを追って全件取得し、名前空間フィルタに対応。
  `regexSearch`はAPIエラー時も例外を投げず「0件・エラーあり」として処理を続行する（仕様書4章）
- **リンク置換／リンク置換2の2ウェーブ構成**（`src/worker/taskRunner.js`、仕様書9章）:
  ウェーブ1でTemplate名前空間（固定）を先に編集→ウェーブ1完了後に対象を再取得→
  ウェーブ2でその他ページ（既定ns=0、複数選択可）を編集。ウェーブ1が0件でも
  ウェーブ2は必ず実行する
- **Category系の`warningSource`**（`src/worker/categoryWarnings.js`）: 置換前Categoryページ
  自体への標準名前空間backlinksを取得し、`Template:リダイレクトの所属カテゴリ`と旧カテゴリ名の
  共起が見つかったページを`task_warnings`テーブルに記録。検出のみで自動編集はしない
- タスク作成画面: 6種類のtemplateTypeすべてが実際に選択・送信可能に。名前空間の複数選択、
  customルールでの4種類の自動取得方式選択に対応
- タスク詳細画面: ウェーブ表示、警告パネル（要手動確認一覧）

**フェーズ5**
- **BOTREQ連携**（`src/worker/botreq.js`、仕様書7章）: `Wikipedia:Bot作業依頼`のwikitextを取得し、
  `WikitextParser`の`argsOrdered`で`{{リンク修正依頼/改名}}`呼び出しを検出・パース。
  「提案」以外の無名引数を順にペア化し、以下のとおり自動分類する:
  - `Category:X`/`Category:Y` → Category置換、`Template:X`/`Template:Y` → テンプレート置換
  - それ以外の通常ページ名同士 → リンク置換（改名元に曖昧さ回避括弧が無く改名先にはある場合は
    自動的にリンク置換2を選択。仕様書7.3節）
  - `REDIRECT_TARGET`/外部URL/アンカー・パイプラベル付き・名前空間不整合なペアは、
    検出のみ行い「未対応」表示にする（実際に編集する前に必ず操作者の確認を要求する設計。7.2節）
- `GET /api/botreq/proposals`（owner専用）: 検出結果をプレビュー用に返す
- タスク作成画面に「Wikipedia:Bot作業依頼 から取得」ボタンを追加。検出された各提案について
  対応済みペア数を表示し、ワンクリックでルールとして取り込める（取り込んだ内容は送信前に
  必ず内容を確認・編集できる。自動即時投入はしない）

**フェーズ6**
- **リンク解除（`unlinkPage`）・テンプレートのsubst化（`templateSubst`）を新規テンプレート種別として実装**
  （`src/worker/templatePresets.js`）。BOTREQの`DELETE_PAGE`／`Template:X→subst:`を、
  検出のみから実際に自動処理できるように対応。`REDIRECT_TARGET`は解決先が時間とともに
  変わりうり操作者から見えにくいという安全上の理由から、引き続き検出のみとする
- **正規表現の精度改善**: `firstLetterFlexiblePattern`を導入し、MediaWikiの実際のタイトル規則
  （先頭1文字だけ大文字小文字を区別しない）に正確に合わせた。実装中に見つかった、
  `templateSubst`の初期実装が`'i'`フラグの副作用で無関係な別テンプレート（例:
  `MyTemplate`指定時に`mytemplate`まで）を誤って巻き込むバグを修正し、全プリセットに適用
- **失敗ページ再試行のUI化**（`POST /api/tasks/:id/retry-failed`）: `completed_with_failures`の
  タスク詳細画面に「失敗ページのみを再試行」ボタンを実装。`edit_log`（`task_pages`が
  クリーンアップされていても残る）を基準に失敗ページ一覧を取得し、元タスクと同じ置換ルール・
  編集設定を引き継いだ新規タスクを作成する（`forceTargets`という新しい内部機構で、
  通常のtargetSource解決をバイパスして指定ページのみを対象にする。ウェーブ分割もしない）
- **編集ログ画面**（`/edit-log`、`GET /api/edit-log`）: タスクID・ページ名・成功/失敗でフィルタ
  検索でき、各行から実際の差分ページ（`action=compare`ではなく本チェックリビジョンへの
  `index.php?diff=`リンク）へ飛べる

**フェーズ7（今回追加）**
- **`Template:リダイレクトの所属カテゴリ`への実際の自動編集**（`src/worker/redirectCategoryTemplate.js`、
  仕様書8章）。`scripts/check-redirect-category-template.js`をToolforge上で実行し取得した
  テンプレート本文・実使用例4件から、正確な引数書式（Luaモジュールではない素のwikitextテンプレートで、
  `redirect1`〜`redirect10` / `1-1`〜`10-20`という名前付き引数にCategory:プレフィックス無しの
  カテゴリ名を直書きする形式）を確認し、検出のみだった実装を実際の自動編集に置き換えた
  - Category置換: 該当引数の値だけをピンポイントで改名（`WikitextParser`の`argsOrdered`で
    位置を特定）
  - Category除去: 該当引数を丸ごと除去（名前付き引数のため番号が飛んでも表示は壊れないことを
    確認済みで、番号の振り直しは行わない）
  - 対象ページの検出は、置換前Categoryページ自体への標準名前空間backlinksから、実際に構造的に
    一致するものだけを自動編集対象に追加する。緩い文字列一致のみ（構造的に確認できないもの）は
    引き続き`task_warnings`で警告表示に留める

**今回の改善**
- Category除去時、`Template:リダイレクトの所属カテゴリ` の残った名前付きカテゴリ引数を、リダイレクトごとに1から連番へ詰め直す
- タスク詳細画面に永続的な実行ログを追加。対象取得・ウェーブ遷移・一時停止・完了理由をDBの`task_logs`に保存して表示する

**含まれないもの（フェーズ8以降）**: BOTREQの`REDIRECT_TARGET`・外部URL・アンカー付きペアへの対応。

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

- `Nanona15dobato` でログイン: ダッシュボード全体（システム状態・タスク一覧・「＋新規タスク作成」・緊急停止）が見える。
- 管理者アカウントでログイン: 緊急停止パネルのみが表示される（他は一切見えない。仕様書2章）。
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

### 3.7 動作確認（ブラウザから）

フェーズ3でOOUIによる画面が揃ったので、通常はブラウザから確認できる。

**必ず`利用者:Nanona15dobato/sandbox`のような実害のないページで試すこと。**

1. `Nanona15dobato`でログインし、ダッシュボード（`/`）の「＋新規タスク作成」から`/tasks/new`へ。
2. アカウントを選択、「置換ルール」で種別「カスタム」のまま正規表現ステップ（例: パターン`テスト前`→置換後`テスト後`）を入力し、対象ページに`利用者:Nanona15dobato/sandbox`を1行で入力。
3. 編集設定（要約欄は必須）・実行モード（まずは`確認待機`がおすすめ）・失敗時の挙動を設定し、「タスクを作成してキューに投入」。
4. 自動的に`/tasks/:id`（タスク詳細画面）へ遷移する。ワーカー（3.6節）が起動していれば、しばらくして対象ページのDiffが「確認中」パネルに表示される。
5. `確認待機`モードなら「承認」ボタンで実際に編集される。「却下」を押すとそのページはスキップされる。
6. ダッシュボードの緊急停止ボタンは、いつでも処理を止められることも合わせて確認しておくとよい。

### 3.8 動作確認（APIリファレンス・curl例）

画面を経由せず直接APIを確認したい場合や、スクリプトから叩きたい場合はこちら。
`Nanona15dobato`でログイン済みのブラウザからセッションCookieを取得し、以下のように使う
（`nanona_bot_sid=...`はブラウザの開発者ツールで確認したセッションCookieの値に置き換える）。

```bash
COOKIE="nanona_bot_sid=xxxxxxxx"
BASE="https://<toolname>.toolforge.org"

# ログイン中ユーザー情報
curl -s "$BASE/api/whoami" -b "$COOKIE"

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
      "editSummary": "Bot: 動作確認",
      "editIntervalSeconds": 10
    },
    "reviewSettings": { "mode": "manual", "manualTimeoutHours": 1 },
    "onFailure": "pause"
  }'
# => {"id": 1}

# タスク一覧・進捗確認
curl -s "$BASE/api/tasks" -b "$COOKIE"

# タスク詳細
curl -s "$BASE/api/tasks/1" -b "$COOKIE"

# ページ一覧（status: pending → preparing → prepared → awaiting_review → ...）
curl -s "$BASE/api/tasks/1/pages" -b "$COOKIE"

# Diff確認（本文込み）
curl -s "$BASE/api/tasks/1/pages/1/diff" -b "$COOKIE"

# 本家同様の差分HTML（action=compare経由）
curl -s "$BASE/api/tasks/1/pages/1/compare" -b "$COOKIE"

# 承認（awaiting_reviewのページにだけ効く）
curl -s -X POST "$BASE/api/tasks/1/pages/1/approve" -b "$COOKIE"

# 却下
curl -s -X POST "$BASE/api/tasks/1/pages/1/reject" -b "$COOKIE"

# onFailure="pause"で止まったタスクの再開
curl -s -X POST "$BASE/api/tasks/1/resume" -b "$COOKIE"
```

## 4. `Template:リダイレクトの所属カテゴリ` の書式確認スクリプト（確認済み）

仕様書8章に対応。**フェーズ7で実際に一次資料を確認し、`src/worker/redirectCategoryTemplate.js`として実装済み**（Luaモジュールではない素のwikitextテンプレートで、`redirect1`〜`redirect10`／`1-1`〜`10-20`という名前付き引数にCategory:プレフィックス無しのカテゴリ名を直書きする形式）。スクリプト自体は今後テンプレートの仕様が変わった場合の再確認用に残してある。

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

実行結果は `redirect-category-template-report.json`（`--out <path>` で変更可）にも保存される。

## 5. ディレクトリ構成

```
server.js                   Webサービスのエントリポイント
worker.js                   ワーカーのエントリポイント（フェーズ2）
src/app.js                  Expressアプリ組み立て（静的配信/セッション/ルート結線）
src/config.js                環境変数の一元管理
src/db.js                    DB接続プール（replica.my.cnf優先）
src/db/replicaCnf.js         replica.my.cnfパーサー（純粋関数）
src/dbJson.js                 JSON列のパース/シリアライズ・ユーティリティ
src/permissions.js           権限判定ロジック（純粋関数）
src/middleware/auth.js       認可ミドルウェア
src/views/shell.js           全ページ共通のHTMLシェル生成（OOUI読み込み・初期データ埋め込み）
src/routes/auth.js           OAuthログイン/コールバック/ログアウト
src/routes/emergency.js      緊急停止API
src/routes/tasks.js         タスクCRUD・進捗確認・承認/却下/再開・再試行・Diff取得・
                              警告一覧・編集ログ検索API
src/routes/pages.js          HTMLページルート（/、/tasks/new、/tasks/:id、/edit-log）
src/routes/botreq.js         BOTREQ取得API（仕様書7章）
src/services/mediawiki.js    ユーザーグループ確認・action=compareによるDiff HTML取得
src/bot/mwClient.js          MediaWiki Botクライアント（生fetch実装。ログイン/取得/編集）
src/bot/cookieJar.js         ログインセッション保持用の簡易CookieJar
src/bot/mwUtil.js            タイムスタンプ変換等の純粋関数
src/bot/accountNames.js      Botアカウント名の静的定義（依存ゼロ、taskConfig.jsから直接利用）
src/bot/accounts.js          アカウント名→ログイン済みクライアントのキャッシュ
src/worker/regexEngine.js    正規表現の複数ステップ置換エンジン（loopUntilStable対応）
src/worker/templatePresets.js テンプレート機能8種類のsteps自動生成（仕様書6章。
                              firstLetterFlexiblePatternでMediaWikiのタイトル規則に対応）
src/worker/targetResolvers.js 対象ページ自動取得（category/backlinks/embeddedin/regexSearch）
src/worker/categoryWarnings.js Category系warningSource収集（構造一致は自動編集対象のため除外。フェーズ7で更新）
src/worker/redirectCategoryTemplate.js Template:リダイレクトの所属カテゴリの検出・カテゴリ引数の
                              改名/除去（仕様書8章。フェーズ7、実テンプレート本文・実例で確認済み）
src/worker/taskConfig.js     タスクconfig_jsonのバリデーション（純粋関数。8種類のtemplateType対応）
src/worker/queue.js          キューからのアトミックなタスクclaim
src/worker/pipeline.js       1ページ先読みパイプライン本体（仕様書9.2節）
src/worker/taskRunner.js     ステージ列挙・2ウェーブ orchestration・警告収集・forceTargets
                              （失敗ページ再試行用の直接ターゲット指定。フェーズ6）
src/worker/botreq.js         BOTREQ({{リンク修正依頼/改名}})の取得・パース・分類（仕様書7章）
src/worker/emergencyStop.js  緊急停止フラグ確認
src/worker/editLog.js        edit_logへの書き込み
public/css/app.css           画面レイアウト＋MediaWiki差分テーブル再現CSS
public/js/common.js          クライアント共通ヘルパー（fetch/通知/ヘッダー/ステータス表示）
public/js/dashboard.js       ダッシュボード画面ロジック
public/js/taskNew.js         タスク作成画面ロジック（8種類のtemplateType・名前空間選択・
                              BOTREQ取り込み対応）
public/js/taskDetail.js      タスク詳細/Diff確認画面ロジック（ストリーミング表示・ウェーブ表示・
                              警告パネル・失敗ページ再試行ボタン）
public/js/editLog.js         編集ログ画面ロジック（検索・フィルタ・差分リンク。フェーズ6）
lib/WikitextParser.js        Wikitext解析共有ライブラリ
scripts/check-redirect-category-template.js
                              Template:リダイレクトの所属カテゴリ 書式確認スクリプト
db/schema.sql                DBスキーマ（tasks/task_pages/edit_log/task_logs/system_status/task_warnings）
test/unit.test.js            権限判定・replica.my.cnfパーサー等のユニットテスト
test/worker.test.js          置換エンジン・タスクconfig検証・JSON列ユーティリティのテスト
test/bot.test.js             MediaWikiBotClientのテスト（fetchをモックし、ログイン〜編集の
                              一連の流れとbasetimestamp伝播を検証）
test/pipeline.test.js        1ページ先読みパイプラインの統合テスト（DBをインメモリスタブ化）
test/templatePresets.test.js テンプレート機能8種類のステップ生成テスト（ハットノート正規表現の
                              回帰テスト、firstLetterFlexiblePatternの誤爆回帰テスト含む）
test/targetResolvers.test.js 対象ページ自動取得のテスト（継続取得・エラー処理をfetchモックで検証）
test/taskRunner.test.js      steps自動生成・ステージ判定・forceTargetsの純粋関数テスト
test/categoryWarnings.test.js Category系警告収集のテスト（構造一致は警告対象外になることの確認含む）
test/redirectCategoryTemplate.test.js Template:リダイレクトの所属カテゴリの改名/除去テスト
                              （Toolforge上で取得した実際のページの呼び出し例を使用。フェーズ7）
test/botreq.test.js          BOTREQパーサーのテスト（ユーザー提示の実例・複合例を含む全分類パターン）
```

`npm test` で全テスト（`node --test`）を実行できる。`public/js/`配下のクライアントサイドJSは、
ブラウザのDOM/OOUIに依存するためこのテストスイートの対象外（構文チェックとAPI呼び出し先の
突合はレビュー済み。3.7節の手順で実ブラウザから確認すること）。

## 6. 既知の制約（フェーズ7時点）

- BOTREQ連携は`REDIRECT_TARGET`/外部URL/アンカー・パイプラベル付き・名前空間不整合な
  ペアを検出のみ行い、自動でルール化しない（仕様書7.2節）。`REDIRECT_TARGET`は解決先が
  時間とともに変わりうり操作者から見えにくいため、安全のため意図的に未対応のままにしている。
  対応する場合はタスク作成画面で手動でルールを追加する。
- `unlinkPage`（リンク解除）はハットノートテンプレート内の参照解除には対応していない
  （通常のwikilink `[[X]]` `[[X|label]]` `[[X#anchor]]` のみ対象）。
- Category系の対象ページ列挙で、カテゴリメンバー検索とTemplate:リダイレクトの所属カテゴリの
  構造確認が、同じbacklinks候補ページに対して独立に本文取得している（`resolveRuleTargetsForStage`と
  `collectWarningsIfNeeded`）。重複取得になるため、実運用でAPI呼び出し数が問題になれば
  取得結果を共有する最適化の余地がある（仕様書14章）。
- 失敗ページ再試行（`forceTargets`）は、元タスクの置換ルールをそのまま引き継ぐが、
  ウェーブ分割・名前空間フィルタは行わない（指定ページを直接対象にするだけの単純な再試行）。
- `regexSearch`の大規模検索時の件数上限は暫定値（`targetResolvers.js`の`MAX_RESULTS=5000`）。
  実運用でのCirrusSearchの負荷傾向を見て調整の余地がある。
- ワーカーがクラッシュ/再起動した場合、処理中だった1ページ分の状態（`preparing`/
  `editing`のまま止まったページ）は自動復旧しない。手動で該当`task_pages`行の
  ステータスを`pending`に戻すか、タスクごと作り直す必要がある（将来的な改善候補）。
- `task_pages.namespace`は、`manualList`/`forceTargets`由来のページでは実際の名前空間ではなく
  常に0が入る（表示用メタデータのみで、置換ロジックには使用していないため実害は無い）。
- OAuthアクセストークンはセッションに保存していない（2章参照）ため、編集はすべて
  BotPasswordアカウント経由のみ。
- `action=compare`のDiff表示はページを開いた/更新した時点のスナップショットで、
  自動リロード（3秒間隔）のたびに再取得はしない（同じページIDの間はキャッシュを使う）。
- テストはユニットテスト＋fetch/DBをモックした統合テストのみで、実際のToolforge/
  ToolsDB/Wikipedia本番環境に対する動作確認、および実ブラウザでのOOUI描画確認は
  行っていない。3.7節の手順でSandboxページに対して実際に確認すること。
- OOUIのアイコンパック（`oojs-ui-wikimediaui-icons-*.css`）は`alerts`/`moderation`/
  `movement`のみ読み込んでいる。使用しているアイコン名がパックに含まれず表示されない
  場合は、`node_modules/oojs-ui/dist/`内の実際のファイル名を確認し、`src/views/shell.js`の
  `<link>`を調整すること。

## 7. ライセンスについて

Toolforgeのポリシー上、公開するコードはOSI承認ライセンスを明示する必要がある。このリポジトリにはまだLICENSEファイルを含めていないので、MIT等お好みのライセンスを選定してLICENSEファイルを追加すること。

## 8. 次のフェーズ

フェーズ8候補: BOTREQの`REDIRECT_TARGET`対応（解決先の可視化・確認フローを含めた安全な設計の検討）、
ハットノート内リンク解除への対応、Category系対象ページ列挙の重複API呼び出し最適化、
監査・通知機能の強化（緊急停止・失敗タスクのアラート等）。
