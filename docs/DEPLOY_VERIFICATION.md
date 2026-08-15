# 実環境デプロイ・動作確認 手順書

`nanonaBot-Web.zip`（フェーズ1〜3）を実際のToolforgeで動かし、確認するまでの通し手順。
上から順に実行すれば、ログイン→タスク作成→実編集→Diff確認まで一通り確認できる。
各コマンドの背景・詳細はREADME.mdの該当節も参照。

チェックボックスはそのまま進捗管理に使ってよい。

---

## 0. 事前準備

- [ ] Toolforgeのツールアカウントを作成済み（未作成なら https://toolsadmin.wikimedia.org/ から作成。以下`<toolname>`はそのツール名に読み替え）
- [ ] SSH公開鍵をToolforgeアカウントに登録済み（同じくtoolsadmin.wikimedia.orgから登録）
- [ ] `Nanona15dobato`と、緊急停止確認用に管理者(sysop)アカウントでもログインできる状態にしておく
- [ ] 手元に`nanonaBot-Web.zip`を展開したフォルダがある

---

## 1. コードをToolforgeへ転送する

ローカル環境（自分のPC）で:

```bash
unzip nanonaBot-Web.zip
# フォルダ nanonaBot-Web/ ができる

# login.toolforge.org 経由でbastionへscp転送
scp -r nanonaBot-Web <あなたのwikitech利用者名>@login.toolforge.org:
```

うまくいかない場合、bastion側のディレクトリ書き込み権限が原因のことが多い。
一度bastionにログインして権限を確認・修正する:

```bash
ssh <あなたのwikitech利用者名>@login.toolforge.org
become <toolname>
# ↓ もし転送先ディレクトリで書き込み権限エラーが出る場合
chmod -R g+w /data/project/<toolname>
exit  # becomeを抜ける
exit  # bastionからログアウト
```

再度 `scp -r nanonaBot-Web ...` を実行する。

---

## 2. bastionにログインし、ツールになる

```bash
ssh <あなたのwikitech利用者名>@login.toolforge.org
become <toolname>
```

以降のコマンドはすべて`become`した状態（`$HOME`が`/data/project/<toolname>`）で実行する。

---

## 3. コードを配置し、www/jsをシンボリックリンクにする

```bash
# scpで送った中身を正式な場所へ（scpの実行結果に応じてパスを調整）
mv ~/nanonaBot-Web ~/nanonaBot-Web.tmp 2>/dev/null  # 既に何か置いてあれば退避
mv ~/nanonaBot-Web.tmp/* ~/ 2>/dev/null              # scpの階層によっては調整が必要
ls ~/nanonaBot-Web   # package.json 等が見えることを確認

mkdir -p ~/www
# 既にwww/jsがあれば退避
[ -e ~/www/js ] && mv ~/www/js ~/www/js.bak

ln -s ~/nanonaBot-Web ~/www/js

# 確認
ls -la ~/www/js
cat ~/www/js/package.json | head -3
```

---

## 4. Wikimedia OAuth 2.0 コンシューマを登録する

1. `Nanona15dobato`で`https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose`にアクセス。
2. 種別「OAuth 2.0」、グラントタイプ「Authorization code」を選択。
3. コールバックURLに `https://<toolname>.toolforge.org/oauth/callback` を入力。
4. 申請すると即座に**Client ID**と**Client Secret**が発行される（自分専用コンシューマの場合、承認待ちなしで使える）。この2つを控えておく。

- [ ] Client ID を控えた
- [ ] Client Secret を控えた

---

## 5. Botパスワードを3アカウント分発行する

`Nanona15dobato` / `NanonaBot` / `NanonaBot3` それぞれで、`https://ja.wikipedia.org/wiki/特別:BotPasswords` にアクセスし、新しいBotパスワードを作成する。

- 権限（グラント）は最低限「ページの編集」「高頻度自動化編集」を付与する。
- 発行されると `ユーザー名@ボット名` の形式のログイン名と、パスワードが表示される（**表示は1回だけ**なので必ず控える）。

- [ ] Nanona15dobato用のBotパスワードを発行した（例: `Nanona15dobato@nanonabot`）
- [ ] NanonaBot用のBotパスワードを発行した
- [ ] NanonaBot3用のBotパスワードを発行した

---

## 6. 依存パッケージをインストールする

```bash
webservice node20 shell
cd ~/nanonaBot-Web
npm install
# oojs-ui/oojs/jquery/express/mysql2等が node_modules に入る

# OOUIの本体ファイルが実際に存在することを確認しておく
ls node_modules/oojs-ui/dist/oojs-ui-wikimediaui.min.js
ls node_modules/oojs-ui/dist/oojs-ui-wikimediaui.min.css

exit
```

- [ ] `npm install` がエラーなく完了した
- [ ] `oojs-ui-wikimediaui.min.js` / `.min.css` の存在を確認した

---

## 7. ToolsDBを準備する

```bash
sql tools
```

MariaDBプロンプトで（`<credentialUser>`は`$HOME/replica.my.cnf`の`user`の値。`SELECT CURRENT_USER();`でも確認できる）:

```sql
CREATE DATABASE IF NOT EXISTS `<credentialUser>__nanona_bot`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
EXIT;
```

スキーマを流し込む:

```bash
cd ~/nanonaBot-Web
mysql --defaults-file=$HOME/replica.my.cnf \
  -h tools.db.svc.wikimedia.cloud \
  <credentialUser>__nanona_bot < db/schema.sql
```

テーブルができたか確認:

```bash
mysql --defaults-file=$HOME/replica.my.cnf \
  -h tools.db.svc.wikimedia.cloud \
  <credentialUser>__nanona_bot -e "SHOW TABLES;"
```

`tasks` / `task_pages` / `edit_log` / `system_status` の4つが表示されればOK
（`sessions`は`express-mysql-session`が初回起動時に自動作成するので、この時点では無くてよい）。

- [ ] DB作成済み
- [ ] `db/schema.sql`流し込み済み
- [ ] `SHOW TABLES`で4テーブルを確認した

---

## 8. 環境変数を設定する

```bash
toolforge envvars create OAUTH_CLIENT_ID
toolforge envvars create OAUTH_CLIENT_SECRET
toolforge envvars create OAUTH_CALLBACK_URL       # https://<toolname>.toolforge.org/oauth/callback
toolforge envvars create OAUTH_WIKI_HOST          # meta.wikimedia.org
toolforge envvars create OWNER_USERNAME           # Nanona15dobato
toolforge envvars create ADMIN_CHECK_WIKI_HOST    # ja.wikipedia.org
toolforge envvars create SESSION_SECRET           # openssl rand -hex 32 の結果などランダムな文字列
toolforge envvars create TOOL_BASE_URL            # https://<toolname>.toolforge.org
toolforge envvars create TOOLSDB_DATABASE_SUFFIX  # nanona_bot
toolforge envvars create TASK_PAGES_RETENTION_DAYS  # 14

# フェーズ2のワーカー用（Botパスワード。5章で控えた値）
toolforge envvars create BOT_NANONA15DOBATO_USER  # 例: Nanona15dobato@nanonabot
toolforge envvars create BOT_NANONA15DOBATO_PASS
toolforge envvars create BOT_NANONABOT_USER       # 例: NanonaBot@nanonabot
toolforge envvars create BOT_NANONABOT_PASS
toolforge envvars create BOT_NANONABOT3_USER      # 例: NanonaBot3@nanonabot
toolforge envvars create BOT_NANONABOT3_PASS
toolforge envvars create WIKI_API_URL             # https://ja.wikipedia.org/w/api.php
```

`openssl rand -hex 32` はbastion上でそのまま実行してその場でコピーしてよい。

登録内容の確認（値は伏字表示）:

```bash
toolforge envvars list
```

- [ ] 上記すべての環境変数を登録した
- [ ] `toolforge envvars list` で登録済み一覧に全項目があることを確認した

---

## 9. Webサービスを起動する

```bash
toolforge webservice node20 start
```

起動確認:

```bash
toolforge webservice status
toolforge webservice logs
```

- [ ] `webservice status` が起動中であることを示している
- [ ] `webservice logs` にクラッシュ・例外が出ていない

---

## 10. ワーカーを起動する

```bash
toolforge jobs run nanona-bot-worker \
  --command "bash -c 'cd ~/nanonaBot-Web && node worker.js'" \
  --image node20 \
  --continuous
```

起動確認:

```bash
toolforge jobs list
toolforge jobs logs nanona-bot-worker
```

ログに `NanonaBot Tool worker starting (poll interval ...)` が出ていれば正常起動。

- [ ] `jobs list` に`nanona-bot-worker`が`Running`で表示されている
- [ ] `jobs logs`起動メッセージを確認した

---

## 11. 動作確認チェックリスト

ブラウザで `https://<toolname>.toolforge.org/` を開きながら進める。
**編集テストは必ず`利用者:Nanona15dobato/sandbox`のような実害のないページで行うこと。**

### 11.1 フェーズ1: 認証・権限・緊急停止

- [ ] 未ログイン状態でアクセス→「Wikimediaアカウントでログイン」ボタンが表示される
- [ ] `Nanona15dobato`でログイン→OAuth認可画面→コールバックでダッシュボードが表示される
- [ ] ダッシュボードに「システム状態」「タスク一覧」「＋新規タスク作成」ボタンが見える
- [ ] 一度ログアウトし、sysop権限を持つ別アカウントでログイン→**緊急停止パネルのみ**が表示され、タスク一覧等は一切見えない
- [ ] 上記管理者アカウントで緊急停止ボタンを押す→「停止中」の表示になる
- [ ] `Nanona15dobato`で再ログインし、ダッシュボードから緊急停止を解除できる（管理者アカウントには解除ボタンが出ないことも合わせて確認）
- [ ] 上記いずれのアカウントでもない適当なアカウントでログイン→403エラーになる

### 11.2 フェーズ2〜3: タスク作成→実編集→Diff確認

1. [ ] `Nanona15dobato`でログインし、「＋新規タスク作成」から`/tasks/new`へ
2. [ ] アカウントは既定の`NanonaBot`のまま
3. [ ] 置換ルールの種別が「カスタム」になっていることを確認し、
   - 正規表現: `テスト前`
   - 置換後: `テスト後`
   - 対象ページ: `利用者:Nanona15dobato/sandbox`（あらかじめそのページ本文に「テスト前」という文字列を書いておく）
4. [ ] 編集設定: 要約欄に適当な文言を入力、Botフラグは`NanonaBot`が実際にbotグループに入っていなければオフにする
5. [ ] 実行モードは「確認待機」、無操作タイムアウトは`1`時間程度
6. [ ] 失敗時の挙動は「一時停止する」
7. [ ] 「タスクを作成してキューに投入」→自動的に`/tasks/1`（タスク詳細）へ遷移する
8. [ ] 数秒〜十数秒待つと「確認中」パネルにDiffが表示される（`action=compare`が動いている証拠）
9. [ ] ブラウザの開発者ツールのコンソールにOOUI関連のエラーが出ていないか確認（静的ファイル404など）
10. [ ] 「承認」ボタンを押す→ページ一覧の該当ページが`edited`になる
11. [ ] 実際に`利用者:Nanona15dobato/sandbox`が編集されたことをWikipedia側で確認する
12. [ ] `sql tools`で`edit_log`テーブルを見て、revid等が記録されていることを確認する
    ```sql
    SELECT * FROM `<credentialUser>__nanona_bot`.edit_log ORDER BY id DESC LIMIT 5;
    ```

### 11.3 失敗時挙動・緊急停止の確認（任意、より厳密に確認したい場合）

- [ ] 存在しないページ名を対象にタスクを作成し、`failed`になることを確認する
- [ ] タスク実行中（`preparing`〜`awaiting_review`のいずれかの間）に緊急停止を押し、処理がその場で止まることを確認する
- [ ] 緊急停止解除後、ワーカーが処理を再開する（新しいタスクから、または`resume`で）ことを確認する

---

## 12. トラブルシューティング

| 症状 | 確認ポイント |
|---|---|
| `webservice node20 start`後もアクセスできない | `toolforge webservice logs`でスタックトレースを確認。多くは環境変数の設定漏れ（`SESSION_SECRET`必須等）か`npm install`未実施 |
| OAuthログインで`state`不一致エラー | `OAUTH_CALLBACK_URL`とMeta側に登録したコールバックURLが完全一致しているか確認（末尾スラッシュの有無等） |
| ログイン後403（denied） | ログインしたアカウント名と`OWNER_USERNAME`の完全一致、または対象アカウントが`ja.wikipedia.org`でsysopグループに入っているかを確認 |
| タスクを作っても`preparing`のまま進まない | ワーカーが起動しているか（`toolforge jobs list`）、`jobs logs nanona-bot-worker`にエラーが出ていないか確認 |
| ワーカーログに`ログインに失敗しました` | 該当アカウントの`BOT_*_USER`/`BOT_*_PASS`の値、Special:BotPasswordsで付与した権限（グラント）を確認 |
| Diffパネルが表示されない/エラーになる | `/api/tasks/:id/pages/:pageId/compare`をブラウザで直接叩いてエラー内容を確認。`base_revid`が入っていない（準備未完了）ことが多い |
| 画面が真っ白・OOUIウィジェットが表示されない | ブラウザの開発者ツールのNetworkタブで`/vendor/oojs-ui/oojs-ui-wikimediaui.min.js`等が404になっていないか確認。404なら6章の`npm install`をやり直す |
| アイコンが表示されない（機能には影響しない） | `node_modules/oojs-ui/dist/`内の実際のアイコンパックファイル名を確認し、`src/views/shell.js`の`<link>`を調整する（README 6章参照） |
| `sql tools`でテーブルが無い | 7章のDB名（`<credentialUser>__nanona_bot`）とスキーマ流し込みをやり直す |

---

以上が一通り確認できれば、フェーズ1〜3の実装が実環境で機能していることになる。
続きはフェーズ4（テンプレート機能・対象ページ自動取得・BOTREQ連携等）。
