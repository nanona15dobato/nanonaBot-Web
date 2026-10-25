# API

画面（`public/js/*.js`）が使っているHTTP APIです。OAuthの開始・コールバック・ログアウト、`/api/whoami` を除きログイン済みのセッションCookieが必要で、権限が足りなければ `403 {"error":"forbidden"}` を返します。状態を変えるリクエスト（POST/PUT/DELETE等）は、別サイトからのもの（Origin/Refererが別ホスト）を `403 forbidden_origin` で拒否します。エラーは `{"error": コード, "message": 説明}` の形です。

ログイン済みの要求では、保存済みの権限を現在の設定・Wikiグループで再判定します。権限を失った既存セッションも新しい権限に従います。Wikiグループを確認できない場合は、以前の権限では通さず `503 {"error":"authorization_unavailable", "message": 説明}` を返します。環境変数の権限一覧はWebサービス再起動後に反映されます。詳しくは [既存セッションの権限失効](configuration.md#既存セッションの権限失効) を参照してください。

## ログイン

| メソッド・パス | 権限 | 内容 |
|---|---|---|
| `GET /oauth/login` | 誰でも | Wikimediaのログイン画面へ移動 |
| `GET /oauth/callback` | 誰でも | ログインの戻り先（ログイン成功時にセッションを作り直す） |
| `POST /oauth/logout` | 誰でも | ログアウト |
| `GET /api/whoami` | 誰でも | ログイン中のアカウント名と権限 |

## 緊急停止

| メソッド・パス | 権限 | 内容 |
|---|---|---|
| `GET /api/emergency-stop/status` | オーナー・緊急停止のみ | 緊急停止の状態・実行者・時刻 |
| `POST /api/emergency-stop` | オーナー・緊急停止のみ | 緊急停止する（通知あり） |
| `POST /api/emergency-stop/clear` | オーナー | 緊急停止を解除する（通知あり） |

## タスク

| メソッド・パス | 内容 |
|---|---|
| `GET /api/tasks` | タスク一覧（新しい順50件。確認待ち件数つき） |
| `GET /api/tasks/attention` | 要対応のタスク一覧 |
| `POST /api/tasks` | タスクを作る（本文はタスクの設定。検証エラーは `400 {"errors": [...]}`） |
| `GET /api/tasks/:id` | タスクの詳細（設定・状態・`server_time`） |
| `GET /api/tasks/:id/pages` | 対象ページの一覧と状態 |
| `GET /api/tasks/:id/pages/:pageId/diff` | ページの準備前・準備後の本文 |
| `GET /api/tasks/:id/pages/:pageId/compare` | 差分HTML（`action=compare`。準備前なら `409 not_ready`） |
| `GET /api/tasks/:id/logs?limit=` | 実行ログ（最大500件） |
| `GET /api/tasks/:id/warnings` | Category系の警告 |
| `POST /api/tasks/:id/pages/:pageId/approve` | 承認（確認待ち・準備完了のページ。それ以外は `409`） |
| `POST /api/tasks/:id/pages/:pageId/reject` | 却下（同上） |
| `POST /api/tasks/:id/review-mode` | 確認モードの切り替え（`{"mode": "auto" \| "manual"}`、待機中・実行中のみ） |
| `POST /api/tasks/:id/cancel` | 中止（待機中・実行中・一時停止のみ） |
| `POST /api/tasks/:id/resume` | 再開（一時停止・緊急停止・期限切れのみ） |
| `POST /api/tasks/:id/retry-failed` | 失敗ページだけの再試行タスクを作る |
| `POST /api/tasks/:id/revert` | 編集の一括取り消しタスクを作る（`{"editSummary", "mode": "auto"\|"manual", "autoWaitSeconds", "manualTimeoutHours", "useUndo": true\|false}`。`useUndo` は後に他の編集があるページを取り消し（undo）と同じ方法で統合する。実行中・待機中は `409 not_revertable`、編集が無ければ `409 nothing_to_revert`） |

権限はすべてオーナーです。

### タスクの設定（`POST /api/tasks` の本文）

```json
{
  "account": "NanonaBot",
  "replacements": [
    { "templateType": "linkRename", "from": "旧記事", "to": "新記事", "namespaces": [0] },
    { "templateType": "categoryRename", "from": "旧", "to": "新", "namespaces": null, "fixCategoryLinks": true },
    { "templateType": "custom",
      "steps": [{ "pattern": "旧", "flags": "g", "replacement": "新" }],
      "targetSource": { "type": "manualList", "titles": ["利用者:Nanona15dobato/sandbox"] } }
  ],
  "editSettings": { "botFlag": true, "minorEdit": true, "editSummary": "Bot: リンク修正",
                    "editIntervalSeconds": 10, "linkUpdateMethod": "nullEdit" },
  "reviewSettings": { "mode": "auto", "autoWaitSeconds": 300 },
  "onFailure": "pause"
}
```

| 項目 | 値 |
|---|---|
| `templateType` | `linkRename` / `linkRename2` / `linkRenameExact` / `categoryRename` / `categoryRemove` / `templateRename` / `unlinkPage` / `templateSubst` / `urlRename` / `custom`（→ [置換ルールの種類](rule-types.md)） |
| `namespaces` | 名前空間番号の配列。`null` は全名前空間、省略時は種別ごとの既定 |
| `fromAnchor` / `toAnchor` / `fromLabel` / `toLabel` | `linkRenameExact` の節・表示名（省略可） |
| `fromAnchorAny` | `linkRenameExact` で改名元の節を問わない（`fromAnchor` とは同時に指定できない。改名先の節が無ければ元の節を残す） |
| `fixCategoryLinks` | `categoryRename` で「Category:旧」の記述も置換する |
| `searchNarrowing` | `linkRename`・`linkRename2`・`linkRenameExact` で、ウェーブ2の対象を全文検索で本文に旧リンクの記述があるページだけに絞る（時間切れ等のときは絞らない） |
| `bothSchemes` | `urlRename` で http:// と https:// の両方の旧URLを付け替える |
| `targetSource.type` | `manualList`（`titles`）/ `category`（`category`）/ `backlinks`・`embeddedin`（`page`）/ `regexSearch`（`query`） |
| `editIntervalSeconds` | 5以上 |
| `linkUpdateMethod` | `nullEdit` / `purge` |
| `reviewSettings` | `{"mode":"auto","autoWaitSeconds":0以上}` または `{"mode":"manual","manualTimeoutHours":正の数}` |
| `onFailure` | `pause` / `skipAndContinue` |
| `botreq` | 任意。Bot作業依頼への紐づけ `{"threadId": "h-…-YYYYMMDDhhmmss", "name": "依頼名"}` |

## その他

| メソッド・パス | 内容 |
|---|---|
| `GET /api/edit-log?task_id=&page_title=&status=&limit=` | 編集ログの検索（`status` は `edited`/`failed`、`limit` は最大200） |
| `GET /api/edit-log.csv?task_id=&page_title=&status=` | 編集ログのCSV（同じ条件で最大10000件。UTF-8・BOMつき） |
| `GET /api/botreq/proposals?threadId=` | Bot作業依頼の `{{リンク修正依頼/改名}}` の分類結果と topic list の進捗。各提案の `request` に、書かれた依頼（`threadId`・`name`）と着手時の Bot の要約 `botSummary`（未着手なら `null`）を付ける。`threadId` を付けるとその依頼の提案だけを返し、`request` にその依頼も返す |
| `GET /api/botreq/link-candidates` | タスクに紐づけられる依頼の一覧（`{{リンク修正依頼/改名}}` の有無を問わない。`threadId`・`name`・`status`・`statusLabel`・`botSummary`・`logTitle`） |
| `GET /api/botreq/account-check` | 保存に使うアカウントの確認。`accounts` に用途（`role`）ごとの結果（`loginName`・`userName`・`groups`・`rights`（`edit`/`createpage`）・`pages`（ページごとの `allowed` と `reasons`）） |
| `GET /api/botreq/requests` | Bot作業依頼の依頼の一覧（`threadId`・`name`・`sectionIndex`・`status`・`requester`・`requestedAt`・`logTitle`・`logState`・紐づけたタスク `tasks` など） |
| `POST /api/botreq/prepare` | 着手・完了・解決で保存する内容を作る（`{"kind": "start"/"complete"/"resolve", "threadId": "h-…"}`）。ウィキは編集しない。返す本文は `before + text + after`。完了では `workSummary.breakdown`（タスクごとの編集数。`taskId: null` はツール以外）も返す。`saveAccount`（保存するアカウント）・`commentAccount`（返信するアカウント）も返す |
| `POST /api/botreq/render` | プレビュー（`{"title", "text"}` → `{"html"}`） |
| `POST /api/botreq/diff` | 差分（`{"title", "oldText", "newText"}` → `{"html"}`。差分の表の行） |
| `POST /api/botreq/save` | 保存（`{"title", "text", "section"?, "summary", "baseTimestamp", "startTimestamp", "createOnly", "comment"?: {"text", "commentId"}}`）。編集競合は 409 |
| `GET /api/bot-accounts/defaults` | Botアカウントごとの既定値 |
| `PUT /api/bot-accounts/:account/defaults` | 既定値の保存 |
| `GET /api/settings/notify` | 通知設定（値と出どころ） |
| `PUT /api/settings/notify` | 通知設定の保存（項目を `null` にすると環境変数の値に戻す） |
| `POST /api/settings/notify/test` | テスト通知（`{"webhook": true/false/null, "mail": true/false/null}`） |
| `GET /api/settings/worker` | ワーカーの動作設定（値・出どころ・範囲） |
| `PUT /api/settings/worker` | ワーカーの動作設定の保存（項目を `null` にすると環境変数・既定値に戻す） |
| `GET /api/system/worker` | ワーカーの稼働状況（`{"known", "alive", "ageSeconds", "state", "taskId"}`） |

権限はすべてオーナーです。

## 端末へのWeb Push

以下はすべてowner専用・現在のログインセッションに限定。状態変更には既存のOrigin/Refererのホスト検査を適用します。レスポンスはHTTPキャッシュに保存しません。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/push/config` | 設定済みか、VAPID公開鍵、イベント一覧・既定値。秘密鍵は返さない |
| GET | `/api/push/subscription?endpointHash=...` | この端末・セッションの有効状態、選択イベント、期限 |
| POST | `/api/push/subscription` | `{subscription, events, publicKey}` で購読を登録。ユーザーとセッションはサーバー側から取得 |
| PUT | `/api/push/subscription` | `{endpointHash, events}` で通知対象を変更。空配列は通知なし |
| DELETE | `/api/push/subscription` | `{endpointHash}` でこのセッションの購読を削除 |
| POST | `/api/push/test` | `{endpointHash}` のこの端末だけへテスト通知。`accepted` はサービスの受付結果 |

`endpointHash` はブラウザ購読URLのSHA-256（小文字16進64文字）。購読URLそのものをクエリーへ入れません。他セッションの識別子をbodyに指定しても採用しません。未設定・未移行時は端末通知だけを無効化または503にし、既存通知の設定は維持します。購読入力の不正は `400 push_error`、公開鍵の変更や端末上限は `409 push_error`、無効な購読への更新・テストは `404 push_error` です。

暗号化Pushペイロードは `{version: 2, event, url, tag}`。`event` は8種類の通常イベントまたは `test` で、Service Workerが固定のイベント別文面へ変換します。自由記述のタイトルや本文は渡しません。古い・不明なイベントの文面は汎用表示です。詳しくは [端末通知](web-push.md) を参照。
