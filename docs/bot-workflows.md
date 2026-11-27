# Bot作業の順番と動作詳解

実装確認日: 2026-11-21。基準コミット: `c19a788d4eeffedcb4c640c09446e8f036d3a4a4`。

25種類の流れを、合計133手順に分けて説明する。

[操作できるHTML版](bot-workflows.html)をブラウザで開くと、作業選択・手順送り・先読み等の説明再生ができる。通信せず、ファイルを直接開いて利用できる。

## 読み方と前提

- 新規タスクは共通の2ウェーブ（global-v1）で処理する。workflowVersionのない既存タスクは、作成時の処理順で再開する。
- 「対象取得」は候補の発見、「本文変換」は実際の一致判定、「承認」は保存可否、「編集」はウィキへの保存。候補件数と実編集件数は同じではない。
- 通常の新規タスクは種別をまたぐ共通2ウェーブ。Templateを先に編集→呼び出し先の更新→通常ページ・所属カテゴリ記述をまとめ編集→任意で残る参照候補を再取得してpurge。
- 停止・中止、再開、失敗ページ再試行、一括取り消しは別操作。停止済みでも過去の編集は残り、再開はfailedページを未処理へ戻さない。
- 対象取得の継続付きリスト関数には通常5000件上限がある。URLのhttp/https統合や複数ルールの集合、手入力等へ一律に「合計5000件」と適用できるわけではない。上限・取得エラー・警告を読む。
- リンク系・外部リンク・Category系は最初にTemplateを対象にする。他種別は選択範囲にTemplateを含む場合だけ第1ウェーブへ入る。第2ウェーブはTemplateを除き、Categoryの特殊参照（標準名前空間）も同じ候補集合へ統合する。
- すべての取得失敗がタスク全体を失敗にするわけではない。insource検索の警告、Category参照走査の失敗、使用ページ再計算の警告などは本編集の失敗件数と区別する。
- BotPasswordによるウィキへの編集と、Wikimedia OAuthによる操作者のログインは別経路。通常タスクは選択したアカウント、作業依頼の保存は対象別の設定アカウントを使う。

## 作業一覧

| 作業 | 分類 | ウェーブ |
|---|---|---|
| [1. タスク全体の実行順](#work-task) | 共通 | 個別処理 |
| [2. 1ページの準備・確認・編集と先読み](#work-page) | 共通 | 個別処理 |
| [3. リンク置換：通常](#work-link) | 置換作業 | 2ウェーブ |
| [4. リンク置換：表示を保持](#work-link-label) | 置換作業 | 2ウェーブ |
| [5. リンク置換：節・表示名を指定](#work-link-exact) | 置換作業 | 2ウェーブ |
| [6. Category置換](#work-category) | 置換作業 | 2ウェーブ |
| [7. Category除去](#work-category-remove) | 置換作業 | 2ウェーブ |
| [8. テンプレート置換](#work-template) | 置換作業 | 2ウェーブ |
| [9. リンク解除](#work-unlink) | 置換作業 | 2ウェーブ |
| [10. テンプレートのsubst化](#work-subst) | 置換作業 | 2ウェーブ |
| [11. 外部リンクの付け替え](#work-url) | 置換作業 | 2ウェーブ |
| [12. カスタム正規表現](#work-custom) | 置換作業 | 2ウェーブ |
| [13. 複数ルールを同じタスクへ入れた場合](#work-mixed) | 共通 | 個別処理 |
| [14. 呼び出し先のリンク表更新：purge／null edit](#work-link-update) | 中間・復旧 | 個別処理 |
| [15. 編集失敗・編集競合・自動再試行](#work-failure) | 中間・復旧 | 個別処理 |
| [16. 一時停止・途中変更・中止・期限切れ・再開](#work-resume) | 中間・復旧 | 個別処理 |
| [17. ワーカー再起動からの復旧](#work-recovery) | 中間・復旧 | 個別処理 |
| [18. 失敗ページだけを新規タスクで再試行](#work-retry-failed) | 中間・復旧 | 1ウェーブ |
| [19. 編集の一括取り消し](#work-revert) | 中間・復旧 | 1ウェーブ |
| [20. Bot作業依頼の読み込み・分類・取り込み](#work-botreq-import) | 作業依頼 | 個別処理 |
| [21. Bot作業依頼：着手を記録](#work-botreq-start) | 作業依頼 | 個別処理 |
| [22. Bot作業依頼：完了を記録](#work-botreq-complete) | 作業依頼 | 個別処理 |
| [23. Bot作業依頼：解決を記録](#work-botreq-resolve) | 作業依頼 | 個別処理 |
| [24. 状態通知と端末へのPush](#work-notifications) | 後処理 | 個別処理 |
| [25. 作業データ整理と稼働記録](#work-cleanup) | 後処理 | 個別処理 |

## 置換構文と対象ページの抽出

HTML版の「構文・対象抽出」で各種別の例と内部パターン、「種別を組み合わせる」で複数種別の共通ウェーブを確認できる。

- 候補取得 → 本文を取得 → マスク対象を保護 → 置換 → 差分確認 → 保存。同じ候補ページでも本文に一致がなければ編集しない。
- 本文の正規表現置換ではnowiki・pre・math・syntaxhighlight・source・score・chem・ce内とコメントを保護する。ref内の出典記述は既定では保護せず、リンク置換の対象になる。
- ページに該当したルールの正規表現ステップを設定順にまとめて実行し、その後にCategory特殊引数・ハットノート解除の構造編集を行う。ルール同士が同じ記述に作用すると結果が変わるため、実タスクの差分を確認する。
- APIリストは継続パラメータを追う。通常5000件で打ち切る関数があるが、複数ルールの和集合や手入力の全体上限という意味ではない。
- 以下の組み合わせは新規global-v1タスクの説明。既存の旧ウェーブ構成、固定対象の再試行・一括取り消しは対象外。

### リンク置換：通常 `linkRename`

[[旧]] → [[新]]。節・表示名を保持し、対応するハットノート内の参照も変更する。

**対象記事の抽出方法**

- 旧ページのリンク元を list=backlinks / bltitle=旧ページ で取得する。テンプレート経由のリンク元も候補になるため、本文に旧リンクがあるとは限らない。
- Template名前空間は先に取得する。通常ページは呼び出し先更新後に再取得し、既定の選択範囲は標準名前空間。
- 任意のsearchNarrowingは通常ページの候補を検索結果との共通部分に絞る。時間切れ・対象過多などではリンク元一覧に戻す。残存purgeではこの絞り込みを使わない。

**置換例 1**

変更前:

```text
[[旧]] / [[旧#節|表示]]
```

保存へ送る本文:

```text
[[新]] / [[新#節|表示]]
```

設定:

```json
{
  "to": "新",
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*旧\\s*(\\]\\]|\\#[^\\]]*\\]\\]|\\|[^\\]]*\\]\\])",
    "flags": "g",
    "replacement": "[[新$1"
  },
  {
    "pattern": "\\[\\[\\s*新\\s*\\|\\s*新\\s*\\]\\]",
    "flags": "g",
    "replacement": "[[新]]"
  },
  {
    "pattern": "(\\{\\{(?:[Ss]ee(?:[ _]also)?|For[12]?|[Mm]ain|[Oo]theruses(?:list|2)?|[Oo]ther[ _](?:people|ships)|混同2?|[Rr]edirect|仮リンク)[^\\}]*\\|\\s*)旧(\\s*[\\|\\}#])",
    "flags": "g",
    "replacement": "$1新$2"
  }
]
```

**置換例 2**

変更前:

```text
{{See also|旧}}
```

保存へ送る本文:

```text
{{See also|新}}
```

設定:

```json
{
  "to": "新",
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*旧\\s*(\\]\\]|\\#[^\\]]*\\]\\]|\\|[^\\]]*\\]\\])",
    "flags": "g",
    "replacement": "[[新$1"
  },
  {
    "pattern": "\\[\\[\\s*新\\s*\\|\\s*新\\s*\\]\\]",
    "flags": "g",
    "replacement": "[[新]]"
  },
  {
    "pattern": "(\\{\\{(?:[Ss]ee(?:[ _]also)?|For[12]?|[Mm]ain|[Oo]theruses(?:list|2)?|[Oo]ther[ _](?:people|ships)|混同2?|[Rr]edirect|仮リンク)[^\\}]*\\|\\s*)旧(\\s*[\\|\\}#])",
    "flags": "g",
    "replacement": "$1新$2"
  }
]
```

**一致条件・補足**

- 置換後の[[新|新]]は[[新]]へ整理する。先頭1文字の大小・空白と下線を同一視するが、タイトル全体の大小を無視するわけではない。

### リンク置換：表示を保持 `linkRename2`

表示名なしの[[旧]]も[[新|旧]]にして、元の表示を残す。

**対象記事の抽出方法**

- 旧ページのリンク元を list=backlinks / bltitle=旧ページ で取得する。テンプレート経由のリンク元も候補になるため、本文に旧リンクがあるとは限らない。
- Template名前空間は先に取得する。通常ページは呼び出し先更新後に再取得し、既定の選択範囲は標準名前空間。
- 任意のsearchNarrowingは通常ページの候補を検索結果との共通部分に絞る。時間切れ・対象過多などではリンク元一覧に戻す。残存purgeではこの絞り込みを使わない。

**置換例 1**

変更前:

```text
[[旧]] / [[旧|別名]]
```

保存へ送る本文:

```text
[[新|旧]] / [[新|別名]]
```

設定:

```json
{
  "to": "新",
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*旧\\s*\\]\\]",
    "flags": "g",
    "replacement": "[[新|旧]]"
  },
  {
    "pattern": "\\[\\[\\s*旧\\s*(\\]\\]|\\#[^\\]]*\\]\\]|\\|[^\\]]*\\]\\])",
    "flags": "g",
    "replacement": "[[新$1"
  },
  {
    "pattern": "\\[\\[\\s*新\\s*\\|\\s*新\\s*\\]\\]",
    "flags": "g",
    "replacement": "[[新]]"
  },
  {
    "pattern": "(\\{\\{(?:[Ss]ee(?:[ _]also)?|For[12]?|[Mm]ain|[Oo]theruses(?:list|2)?|[Oo]ther[ _](?:people|ships)|混同2?|[Rr]edirect|仮リンク)[^\\}]*\\|\\s*)旧(\\s*[\\|\\}#])",
    "flags": "g",
    "replacement": "$1新$2"
  }
]
```

**一致条件・補足**

- 既存の表示名は保持する。置換後の[[新|新]]の整理と対応するハットノートの処理も行う。

### リンク置換：節・表示名を指定 `linkRenameExact`

[[旧#節|表示]]の節・表示名に条件を付けて、リンク先・節・表示を変更する。

**対象記事の抽出方法**

- 旧ページのリンク元を list=backlinks / bltitle=旧ページ で取得する。テンプレート経由のリンク元も候補になるため、本文に旧リンクがあるとは限らない。
- Template名前空間は先に取得する。通常ページは呼び出し先更新後に再取得し、既定の選択範囲は標準名前空間。
- 任意のsearchNarrowingは通常ページの候補を検索結果との共通部分に絞る。時間切れ・対象過多などではリンク元一覧に戻す。残存purgeではこの絞り込みを使わない。

**置換例 1**

変更前:

```text
[[旧#節A|ラベル]] / [[旧#節A|別名]]
```

保存へ送る本文:

```text
[[新#節B|新ラベル]] / [[旧#節A|別名]]
```

設定:

```json
{
  "to": "新",
  "fromAnchor": "節A",
  "toAnchor": "節B",
  "fromLabel": "ラベル",
  "toLabel": "新ラベル",
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*旧\\s*\\#\\s*節A\\s*\\|\\s*ラベル\\s*\\]\\]",
    "flags": "g",
    "replacement": "[[新#節B|新ラベル]]"
  }
]
```

**置換例 2**

変更前:

```text
[[旧#節A|ラベル]]
```

保存へ送る本文:

```text
[[新#節A|ラベル]]
```

設定:

```json
{
  "to": "新",
  "fromAnchorAny": true,
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*旧\\s*(\\#[^\\]\\|]*?)?\\s*\\|([^\\]]*)\\]\\]",
    "flags": "g",
    "replacement": "[[新$1|$2]]"
  },
  {
    "pattern": "\\[\\[\\s*旧\\s*(\\#[^\\]\\|]*?)?\\s*\\]\\]",
    "flags": "g",
    "replacement": "[[新$1]]"
  }
]
```

**一致条件・補足**

- fromAnchorを指定するとその節だけ、fromAnchorAny=trueなら節を問わない。両方なしは節なしのリンクだけ。
- fromLabelを指定するとその表示名だけ。未指定なら既存の表示名を保持する。節を問わずtoAnchorもなければ元の節を残す。ハットノートは変更しない。

### Category置換 `categoryRename`

[[Category:旧|ソートキー]] → [[Category:新|ソートキー]]。所属カテゴリの特殊引数も変更する。

**対象記事の抽出方法**

- list=categorymembers / cmtitle=Category:旧 でカテゴリメンバーを取得する。Templateを先に編集し、その呼び出し先のリンク表・カテゴリ所属を更新してから通常メンバーを取り直す。
- 通常ページでは標準名前空間の旧カテゴリへのbacklinksも本文走査し、{{リダイレクトの所属カテゴリ}}のN-M引数に構造的に一致するページを候補へ加える。通常タグの修正と同じウェーブ・同じ編集にまとめる。
- 自動取得の既定は全名前空間。global-v1のTemplate優先処理と、標準名前空間の特殊参照走査は通常ページの選択範囲とは別に行う。
- fixCategoryLinksを選ぶと、通常ページでカテゴリへのbacklinksと insource:"Category:旧" の検索結果も加える。

**置換例 1**

変更前:

```text
[[Category:旧|あ]]
{{リダイレクトの所属カテゴリ|redirect1=X|1-1=旧}}
```

保存へ送る本文:

```text
[[Category:新|あ]]
{{リダイレクトの所属カテゴリ|redirect1=X|1-1=新}}
```

設定:

```json
{
  "to": "新",
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*(?:Category|category|カテゴリ):\\s*旧\\s*(\\|[^\\]]*)?\\]\\]",
    "flags": "g",
    "replacement": "[[Category:新$1]]"
  },
  {
    "pattern": "(\\[\\[\\s*(?:Category|category|カテゴリ):\\s*新\\s*(?:\\|[^\\]]*)?\\]\\])([\\s\\S]*?)\\n?\\[\\[\\s*(?:Category|category|カテゴリ):\\s*新\\s*(?:\\|[^\\]]*)?\\]\\]",
    "flags": "",
    "replacement": "$1$2",
    "loopUntilStable": true
  },
  {
    "pattern": "(\\{\\{(?:[Ss]ee(?:[ _]also)?|For[12]?|[Mm]ain|[Oo]theruses(?:list|2)?|[Oo]ther[ _](?:people|ships)|混同2?|[Rr]edirect|仮リンク)[^\\}]*\\|\\s*)旧(\\s*[\\|\\}#])",
    "flags": "g",
    "replacement": "$1新$2"
  }
]
```

**置換例 2**

変更前:

```text
[[:Category:旧]]
```

保存へ送る本文:

```text
[[:Category:新]]
```

設定:

```json
{
  "to": "新",
  "fixCategoryLinks": true,
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*(?:Category|category|カテゴリ):\\s*旧\\s*(\\|[^\\]]*)?\\]\\]",
    "flags": "g",
    "replacement": "[[Category:新$1]]"
  },
  {
    "pattern": "(\\[\\[\\s*(?:Category|category|カテゴリ):\\s*新\\s*(?:\\|[^\\]]*)?\\]\\])([\\s\\S]*?)\\n?\\[\\[\\s*(?:Category|category|カテゴリ):\\s*新\\s*(?:\\|[^\\]]*)?\\]\\]",
    "flags": "",
    "replacement": "$1$2",
    "loopUntilStable": true
  },
  {
    "pattern": "(\\{\\{(?:[Ss]ee(?:[ _]also)?|For[12]?|[Mm]ain|[Oo]theruses(?:list|2)?|[Oo]ther[ _](?:people|ships)|混同2?|[Rr]edirect|仮リンク)[^\\}]*\\|\\s*)旧(\\s*[\\|\\}#])",
    "flags": "g",
    "replacement": "$1新$2"
  },
  {
    "pattern": "(?<![A-Za-z])(Category|category|カテゴリ)(\\s*:\\s*)旧(?=[ _]*(?:[\\]|#}<\\n、。，．）」』)]|$)|[ _]+[^A-Za-z0-9 _])",
    "flags": "g",
    "replacement": "$1$2新"
  }
]
```

**一致条件・補足**

- Category/category/カテゴリ表記の所属タグを変更し、重複した新カテゴリタグを整理する。
- fixCategoryLinks=trueなら[[:Category:旧]]や地の文のCategory:旧も変更する。別名の一部に一致する箇所は境界条件で除外する。構造を確認できない特殊参照は警告へ回す。

### Category除去 `categoryRemove`

[[Category:旧]]を削除する。特殊な所属カテゴリ引数を除去し、残る引数の番号を詰める。

**対象記事の抽出方法**

- list=categorymembers / cmtitle=Category:旧 でカテゴリメンバーを取得する。Templateを先に編集し、その呼び出し先のリンク表・カテゴリ所属を更新してから通常メンバーを取り直す。
- 通常ページでは標準名前空間の旧カテゴリへのbacklinksも本文走査し、{{リダイレクトの所属カテゴリ}}のN-M引数に構造的に一致するページを候補へ加える。通常タグの修正と同じウェーブ・同じ編集にまとめる。
- 自動取得の既定は全名前空間。global-v1のTemplate優先処理と、標準名前空間の特殊参照走査は通常ページの選択範囲とは別に行う。

**置換例 1**

変更前:

```text
本文
[[Category:旧]]
```

保存へ送る本文:

```text
本文
```

設定:

```json
{
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\n?\\[\\[\\s*(?:Category|category|カテゴリ):\\s*旧\\s*(\\|[^\\]]*)?\\]\\]",
    "flags": "g",
    "replacement": ""
  }
]
```

**一致条件・補足**

- 直前の改行も削除対象になる。Category置換の「一般記述も変更する」オプションは使わない。

### テンプレート置換 `templateRename`

{{旧|引数}} → {{新|引数}}。呼び出し名だけを変更する。

**対象記事の抽出方法**

- list=embeddedin / eititle=Template:旧 で使用ページを取得する。
- 既定は標準名前空間。Templateも選ぶとTemplate内の呼び出しを第1ウェーブで修正し、呼び出し先更新後に通常ページの候補を取り直す。

**置換例 1**

変更前:

```text
{{旧|a=値}}
```

保存へ送る本文:

```text
{{新|a=値}}
```

設定:

```json
{
  "to": "新",
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "(\\{\\{\\s*)旧\\s*([\\|\\}])",
    "flags": "g",
    "replacement": "$1新$2"
  }
]
```

**一致条件・補足**

- 引数名・引数値を置換する種別ではない。from/toはTemplate:を除いた名前として処理される。

### リンク解除 `unlinkPage`

[[旧|表示]] → 表示、[[旧#節]] → 旧。対応する一覧型ハットノートから参照を外す。

**対象記事の抽出方法**

- list=backlinks / bltitle=旧ページ でリンク元を取得する。既定は標準名前空間。
- global-v1では選択範囲にTemplateを含む場合に第1ウェーブへ、それ以外を第2ウェーブへ分ける。

**置換例 1**

変更前:

```text
[[旧|表示]] / [[旧#節]]
```

保存へ送る本文:

```text
表示 / 旧
```

設定:

```json
{
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*旧\\s*(?:\\#[^\\]|]*)?\\|([^\\]]*)\\]\\]",
    "flags": "g",
    "replacement": "$1"
  },
  {
    "pattern": "\\[\\[\\s*旧\\s*(?:\\#[^\\]]*)?\\]\\]",
    "flags": "g",
    "replacement": "旧"
  }
]
```

**置換例 2**

変更前:

```text
{{See also|旧|別}}
```

保存へ送る本文:

```text
{{See also|別}}
```

設定:

```json
{
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "\\[\\[\\s*旧\\s*(?:\\#[^\\]|]*)?\\|([^\\]]*)\\]\\]",
    "flags": "g",
    "replacement": "$1"
  },
  {
    "pattern": "\\[\\[\\s*旧\\s*(?:\\#[^\\]]*)?\\]\\]",
    "flags": "g",
    "replacement": "旧"
  }
]
```

**一致条件・補足**

- ハットノートはSee also・See・Main・混同などの一覧型だけ。For・Otherusesなど役割が異なるものや名前付き引数がある呼び出しは変更しない。

### テンプレートのsubst化 `templateSubst`

{{旧|引数}} → {{subst:旧|引数}}。保存時にMediaWikiが展開する。

**対象記事の抽出方法**

- list=embeddedin / eititle=Template:旧 で使用ページを取得する。既定は標準名前空間。
- 選択範囲にTemplateを含む場合は第1ウェーブ、それ以外は第2ウェーブに分ける。

**置換例 1**

変更前:

```text
{{旧|x=1}} / {{subst:旧}}
```

保存へ送る本文:

```text
{{subst:旧|x=1}} / {{subst:旧}}
```

設定:

```json
{
  "from": "旧"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "(\\{\\{\\s*)(?!subst:|safesubst:)旧\\s*([\\|\\}])",
    "flags": "g",
    "replacement": "$1subst:旧$2"
  }
]
```

**一致条件・補足**

- 既存の小文字subst:・safesubst:呼び出しには重ねて付けない。ここで示す変更後は保存へ送る本文で、ウィキ上の展開結果ではない。

### 外部リンクの付け替え `urlRename`

旧URLの接頭辞を新URLへ変更する。外部リンク・素のURL・テンプレート引数を扱う。

**対象記事の抽出方法**

- list=exturlusage / euquery=プロトコルを除いた旧URL / euprotocol=httpまたはhttps で候補を取得する。
- bothSchemes=trueならhttp/httpsの取得結果を統合し、ページ単位で重複を除く。Templateを優先し、更新後に通常ページの候補を取り直す。

**置換例 1**

変更前:

```text
[http://old.example/a 表示] {{Cite web|url=http://old.example/b}}
```

保存へ送る本文:

```text
[https://new.example/a 表示] {{Cite web|url=https://new.example/b}}
```

設定:

```json
{
  "to": "https://new.example/",
  "from": "http://old.example/"
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "(?<![\\w.\\-/:])(?:[Hh][Tt][Tt][Pp]://)[Oo][Ll][Dd]\\.[Ee][Xx][Aa][Mm][Pp][Ll][Ee]/",
    "flags": "g",
    "replacement": "https://new.example/"
  }
]
```

**一致条件・補足**

- 旧URLが/で終われば配下全体。そうでなければ末尾の区切り条件を満たすURLだけ。取得は前方一致なので、候補に入っても本文が置換条件に合わなければスキップする。
- スキーム・ホストは大小を問わず、パスは区別する。bothSchemesは取得と本文変換の両方に作用する。

### カスタム正規表現 `custom`

pattern・flags・replacementのステップを順番に実行する。$1等のキャプチャ参照を使える。

**対象記事の抽出方法**

- 対象取得方法をmanualList / category / backlinks / embeddedin / regexSearchから選ぶ。各方法は下の「抽出方法一覧」を参照。
- 取得したページを実際の名前空間で分ける。手入力は指定名を採用し、名前空間を本文取得時に照合する。

**置換例 1**

変更前:

```text
旧語A 旧語B
```

保存へ送る本文:

```text
新語A 新語B
```

設定:

```json
{
  "steps": [
    {
      "pattern": "旧語([AB])",
      "flags": "g",
      "replacement": "新語$1"
    }
  ]
}
```

実装から生成した正規表現ステップ:

```json
[
  {
    "pattern": "旧語([AB])",
    "flags": "g",
    "replacement": "新語$1"
  }
]
```

**一致条件・補足**

- 検索用のinsource正規表現と、本文置換用のJavaScript正規表現は別。検索に一致しても本文変換で差がなければスキップする。
- loopUntilStableは安定するまで同じステップを繰り返す（上限あり）。空文字に一致して文字を増殖させるパターンは設定時に拒否する。

### 抽出方法一覧

**手入力** (`manualList`)

```text
targetSource: {type:"manualList", titles:["記事A","Template:T"]}
```

ページ名の一覧をそのまま候補にする。初期名前空間を推測せず、取得して照合する。最終残存purgeの再取得対象にはしない。

**カテゴリメンバー** (`category`)

```text
action=query&list=categorymembers&cmtitle=Category:旧&cmnamespace=0
```

所属カテゴリの索引から候補を取る。テンプレート由来の間接所属も含まれ、本文にカテゴリタグがあるとは限らない。

**リンク元** (`backlinks`)

```text
action=query&list=backlinks&bltitle=旧記事&blnamespace=0
```

内部リンク表から候補を取る。節・表示名などの厳密な一致は本文の置換段階で判定する。

**テンプレート使用ページ** (`embeddedin`)

```text
action=query&list=embeddedin&eititle=Template:旧&einamespace=0
```

呼び出し先一覧を候補にする。Template優先編集後の呼び出し先更新にもこの取得方法を使うが、更新するのは呼び出し先である。

**正規表現検索** (`regexSearch`)

```text
action=query&list=search&srsearch=insource:/旧語/&srnamespace=0
```

検索索引から候補を取る。索引反映遅れ・時間切れ・上限で取りこぼす場合がある。検索警告は編集APIの失敗と区別する。

### 複数種別を組み合わせる

HTML版で種別を複数選び、適用順・通常名前空間・カスタムの取得元・呼び出し先更新・残存purge・確認方法を変えると、処理区間を組み直す。同じページに該当する例と別々のページに該当する例を切り替え、保存回数の違いを確認できる。実際の候補取得や編集は行わない。


<a id="work-task"></a>

## 1. タスク全体の実行順

分類: 共通。ウェーブ: 共通・個別処理。

作成したタスクはDBのキューに入り、常駐ワーカーが古いものから1件ずつ処理する。

### 処理順

1. **設定を確定して登録**（作成／Webサーバー）

   アカウント、置換ルール、編集設定、確認モード、失敗時の挙動を検証し、config_jsonとqueued状態を保存する。ここではページを編集しない。

2. **緊急停止を調べる**（待機／ワーカー）

   停止中は新しいタスクを取り出さず、既定1秒の周期で確認を続ける。作業データの掃除はこの判定より前にタスクの合間で実行する。

3. **最も古い待機タスクを取得**（取得／ワーカー＋DB）

   created_atの昇順でqueuedを1件選び、トランザクション内でrunningへ変更する。同じ作成時刻のタスク同士の順番は追加指定されていない。

4. **実行準備**（準備／ワーカー）

   プリセットを置換ステップへ展開し、global-v1の通常タスクは共通2ウェーブ、再試行・取り消し等の固定対象は1ウェーブにする。旧タスクは保存済みの種別別構成を維持する。Categoryの警告走査は最初のウェーブ前に終える。

5. **各ウェーブを順番に処理**（反復／ワーカー）

   全ルールをTemplate／通常ページに分けて集約する。Template編集後に呼び出し先を更新し、通常ページの候補を取り直す。同じタイトルの変更はルールの種別をまたいで1つのtask_pagesにまとめる。

6. **最終状態を確定**（完了／ワーカー＋DB）

   必要なら旧参照の残存候補を再取得して一度だけpurgeする。その後task_pagesのfailed有無で完了／一部失敗を確定する。purgeの個別失敗は別の更新ログ・チェックポイントに残る。

7. **終了・停止理由を通知**（通知／ワーカー）

   runTaskから戻った後に実際のタスク状態を読み、対応するイベントを通知する。続いて別の待機タスクへ進む。

### 分岐

- **前のウェーブが0件**: 次のウェーブの対象取得も実行する。
- **対象が上限や検索警告付き**: 取得できた結果で続行する経路がある。完了表示だけで全候補の取得を保証しない。
- **ログイン等で予期しない例外**: 中止済みでなければfailedへ変更し、理由を記録する。

### 確認点

- タスクの並列実行は前提にしていない。ワーカーは1つだけ運用する。
- 確認待ち中も現在のタスクがワーカーを占有する。次のタスクは先に始まらない。
- API取得順を登録順に使う。ページ名の辞書順に並べ替える処理はない。
- 新規タスクに保存するworkflowVersionはglobal-v1。既存タスクのconfig_jsonを一括で書き換える移行はしない。

### 実装の根拠

- [src/routes/tasks.js](../src/routes/tasks.js) — `validateTaskConfig`
- [worker.js](../worker.js) — `mainLoop`
- [src/worker/queue.js](../src/worker/queue.js) — `claimNextQueuedTask`
- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `runTask`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `stageCount`

<a id="work-page"></a>

## 2. 1ページの準備・確認・編集と先読み

分類: 共通。ウェーブ: 共通・個別処理。

現在のページを確認している間に、次に編集が必要なページを1件先まで準備する。

### 処理順

1. **本文と版を取得**（準備／ワーカー）

   pendingをpreparingにし、最新版の本文、版ID、版時刻、取得時刻、実際の名前空間を取得する。存在しないページや取得失敗はfailedになる。

2. **一致したルールを順番に適用**（変換／ワーカー）

   そのウェーブの対象取得でこのページに紐づいたルールだけを使う。設定配列の順で正規表現ステップを連結して実行し、その後Category引数やハットノートの構造編集を行う。

3. **変更の有無を保存**（判定／ワーカー＋DB）

   同じ本文ならskipped。変更があれば元本文・新本文・版情報を保存してpreparedにする。元本文と新本文を画面から差分として確認できる。

4. **次候補の先読みを開始**（並行準備／ワーカー）

   次の候補を裏で準備し、変更なしならその場でskippedを確定してさらに次へ進む。変更あり、または準備失敗の候補が1件見つかるとそこで待つ。

5. **確認を待つ**（確認／人／ワーカー）

   preparedをawaiting_reviewへ進める。自動モードは確認待ち開始から指定秒後に承認、手動モードは人の承認を待つ。先読み時点から待機秒数を数えるわけではない。

6. **承認後に保存**（編集／Botクライアント）

   Botアカウントで、準備時のbasetimestampとstarttimestamp、assert=user、maxlag=5、nocreateを付けて編集する。成功ならeditedとedit_logに結果を保存する。

7. **次候補への間隔を調整**（移行／ワーカー）

   次候補があれば、編集処理が戻った後の時刻から設定間隔の残りを待つ。先読みにかかった時間は差し引く。最後の候補の後、変更なしや却下の後は通常の編集間隔を追加しない。

### 分岐

- **変更なし**: 確認待ちにせずスキップし、次候補を探す。
- **却下**: rejectedにし、このページは編集しない。
- **承認・API成功**: editedを記録する。差分確認はサーバーで準備した新本文が対象。
- **緊急停止**: 停止点で検知する。すでに送信したAPIを取り消すものではなく、通信やsleepの途中で即時終了する保証もない。

### 確認点

- 先読みは編集の並列実行ではない。ウィキへの本編集は順番に行う。
- 先読み済みのpreparedページは、順番が来る前に承認・却下できる。再開後には準備し直すため、以前の承認を引き継がない。
- 保護領域のマスク→正規表現ステップ→保護領域の復元→構造編集という順番。

### 実装の根拠

- [src/worker/pipeline.js](../src/worker/pipeline.js) — `buildNewWikitext`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `prepareOnePage`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `waitForApproval`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `runStagePipeline`
- [src/bot/mwClient.js](../src/bot/mwClient.js) — `editOnce`

<a id="work-link"></a>

## 3. リンク置換：通常

分類: 置換作業。ウェーブ: 2。

リンク先を付け替え、指定済みの節・表示名を原則として残す。Templateを先に直してから対象を取り直す。

### 処理順

1. **ウェーブ1の対象取得**（ウェーブ1／対象取得）

   旧ページへのbacklinksをTemplate名前空間（10）固定で取得する。通常リンク系のウェーブ1は、ルールで指定した名前空間によって省略されない。

2. **Template内を置換**（ウェーブ1／ワーカー）

   [[旧…]]のリンク先を新へ変更する。[[新|新]]のように同じ表示名が重複したリンクを[[新]]へ整理し、対応するハットノート引数も置換する。

3. **差分確認・編集**（ウェーブ1／人／ワーカー）

   差分確認してTemplateを保存する。種別を問わず実際に編集したTemplateを集め、設定が有効ならその呼び出し先をpurge（またはnull edit）してから次へ進む。

4. **ウェーブ2を再取得**（ウェーブ2／対象取得）

   呼び出し先の更新後にbacklinksを再照会する。選択された名前空間からTemplateを除いた候補を集め、他種別が取得した同じページとまとめる。

5. **任意の検索絞り込み**（ウェーブ2／対象取得）

   searchNarrowingが有効ならリンク元と全文検索結果の共通部分に絞る。標準名前空間の改名元、50候補以上などの条件を満たす場合だけ行う。

6. **残りを確認・編集**（ウェーブ2／人／ワーカー）

   同じページのテンプレート置換やCategory修正もまとめて準備・確認・保存する。設定をオンにした場合は、その後もう一度残る参照候補を取得してpurgeする。

### 具体例

変更前:

```text
[[旧記事]] / [[旧記事#節|表示]]
```

変更後:

```text
[[新記事]] / [[新記事#節|表示]]
```

from=旧記事、to=新記事。

### 分岐

- **検索が時間切れ・失敗・1万件超**: 絞り込む前のリンク元一覧へ戻す。
- **名前空間付きの改名元・候補50件未満**: 検索では絞り込まない。

### 確認点

- リンク元にはテンプレート経由の参照も含まれ得る。候補になったページをすべて編集するわけではない。
- 検索の索引に未反映の最近の編集は絞り込みで漏れる可能性があるため、既定では絞り込まない。
- purgeするのは呼び出し先／残存参照ページ。編集したTemplate本体だけをpurgeして済ませる処理ではない。

### 実装の根拠

- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `resolveRuleTargetsForStage`
- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `linkRenameSteps`
- [src/worker/searchNarrowing.js](../src/worker/searchNarrowing.js) — `narrowBySearch`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-link-label"></a>

## 4. リンク置換：表示を保持

分類: 置換作業。ウェーブ: 2。

表示名のない旧リンクへ旧名を補う。実行順は種別共通の2ウェーブと呼び出し先更新に従う。

### 処理順

1. **Templateのリンク元を取得**（ウェーブ1／対象取得）

   通常リンク置換と同じウェーブ1。内部の種別はlinkRename2。

2. **表示名のない旧リンクを先に処理**（変換／ワーカー）

   [[旧]]を[[新|旧]]へ変える。節・表示名付きのリンクを処理するステップより先に実行する。

3. **その他のリンクとハットノートを処理**（変換／ワーカー）

   節や既存表示名のあるリンクはリンク先を新へ変え、[[新|新]]は簡約する。対応ハットノート引数も変更する。

4. **確認・編集後に対象を再取得**（ウェーブ2／ワーカー）

   Templateのまとめ編集と任意の呼び出し先更新後、指定名前空間のリンク元を再取得する。通常ページでは他種別の変更と同じ編集にまとめる。

5. **残りへ同じ処理**（ウェーブ2／人／ワーカー）

   確認・保存後、設定があれば残る参照候補を一度だけ再取得してpurgeする。

### 具体例

変更前:

```text
[[旧記事]] / [[旧記事|別名]]
```

変更後:

```text
[[新記事|旧記事]] / [[新記事|別名]]
```

表示名が既にあればその表示名を使う。

### 確認点

- 「表示を保持」は表示名なしの旧リンクへ旧名を補う挙動。あらゆるウィキ構文の表示を完全に保持するという意味ではない。

### 実装の根拠

- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `linkRename2Steps`
- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `resolveRuleTargetsForStage`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-link-exact"></a>

## 5. リンク置換：節・表示名を指定

分類: 置換作業。ウェーブ: 2。

旧リンクの節・表示名を条件にして付け替える。取得順は通常リンク置換と同じ。

### 処理順

1. **一致条件を確定**（設定／人）

   旧ページ、新ページ、節なし／節を問わない／指定節、旧表示名・新表示名を設定する。内部種別はlinkRenameExact。

2. **Templateのリンク元を取得**（ウェーブ1／対象取得）

   旧ページのbacklinksを取得する。取得API自体が節や表示名で候補を絞るわけではない。

3. **本文中で条件を照合**（変換／ワーカー）

   節や表示名が条件に合うリンクだけを変更する。節を問わず新しい節も未指定なら、元の節を残す。新しい表示名が未指定なら既存表示名、必要に応じ旧名を使う。

4. **確認・編集してから再取得**（ウェーブ2／人／ワーカー）

   Templateを確認・編集し、設定が有効ならその呼び出し先を更新する。次に通常ページの候補を再取得して他の種別とまとめる。任意で最後に残存候補をpurgeする。

### 具体例

変更前:

```text
[[旧記事#節A|ラベル]] / [[旧記事#節B|別]]
```

変更後:

```text
[[新記事#節C|新ラベル]] / [[旧記事#節B|別]]
```

旧節=節A・旧表示名=ラベル、新節=節C・新表示名=新ラベルの例。

### 確認点

- 通常のlinkRenameと異なり、この種別の生成ステップにはハットノート置換を含めない。
- 取得候補であっても節・表示名が条件外なら変更なしになる。

### 実装の根拠

- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `linkRenameExactSteps`
- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `resolveRuleTargetsForStage`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-category"></a>

## 6. Category置換

分類: 置換作業。ウェーブ: 2。

Templateを先に編集して呼び出し先を更新し、通常のカテゴリタグと「リダイレクトの所属カテゴリ」の修正を同じページの1回の編集にまとめる。

### 処理順

1. **警告候補を先に走査**（事前確認／ワーカー）

   旧カテゴリページの標準名前空間のリンク元を走査し、要手動確認を記録する。通常ページの候補取得ではTemplate編集・更新後の新しい走査キャッシュを使う。

2. **Templateのカテゴリメンバー取得**（ウェーブ1／対象取得）

   旧カテゴリのTemplateメンバーを取得する。新構成では通常ページ側の名前空間指定にかかわらずTemplateを先行対象にする。

3. **カテゴリを付け替えて編集**（ウェーブ1／人／ワーカー）

   旧カテゴリタグを新へ変更し、重複した新カテゴリタグを整理する。対応ハットノートも処理する。fixCategoryLinks有効時はCategory:旧の文字列処理も加える。差分確認後に保存する。

4. **編集済みTemplateの使用ページを再計算**（中間処理／ワーカー）

   種別を問わず第1ウェーブで実際にeditedになったTemplateの呼び出し先を全名前空間から集める。既定はpurge＋forcelinkupdate。更新を無効にするか、null editを選ぶこともできる。

5. **カテゴリメンバーを再取得**（ウェーブ2／人／ワーカー）

   旧カテゴリメンバーを再取得しTemplateを除く。それと同時に標準名前空間の「リダイレクトの所属カテゴリ」等の候補も取得する。

6. **通常タグと特殊参照を同じ候補へ統合**（ウェーブ2／対象取得）

   通常メンバー、特殊テンプレートの構造一致、任意のCategory:旧の一般記述、他種別の候補をタイトル単位に統合する。同じページなら該当ルールを同じ確認・編集にまとめる。

7. **構造と文字列を処理して保存**（ウェーブ2・後処理／人／ワーカー）

   正規表現ステップの後で所属カテゴリ引数も修正し、ひとつの新本文を確認・保存する。任意で残存候補を再取得してpurgeしてから完了する。

### 具体例

変更前:

```text
[[Category:旧|ソートキー]]
```

変更後:

```text
[[Category:新|ソートキー]]
```

新カテゴリの重複があれば整理する。任意の文字列置換では別カテゴリ名の一部や区切りのない和文を避ける。

### 分岐

- **構造を確認できない記述**: 自動編集対象への追加とは別に警告へ残る場合がある。警告欄も確認する。
- **再計算に一部失敗**: task_logsへ警告を残して次へ進む。これ自体をtask_pagesのfailed件数へ加算する処理ではない。
- **fixCategoryLinksがオフ**: 地の文等のCategory:旧の一般文字列置換・追加候補取得は行わない。

### 確認点

- Category名の入力ではCategory:やカテゴリ:の接頭辞を除いてルールを生成する。
- 特殊参照の標準名前空間固定は、ルール全体の名前空間指定とは別。
- 再計算失敗や索引遅延があれば、テンプレート経由のページが候補に残る場合もある。候補取得後に本文の変更有無を判定する。

### 実装の根拠

- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `runTask`
- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `resolveCategoryMentionTargets`
- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `categoryRenameSteps`
- [src/worker/redirectCategoryTemplate.js](../src/worker/redirectCategoryTemplate.js) — `renameCategoryInTemplate`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-category-remove"></a>

## 7. Category除去

分類: 置換作業。ウェーブ: 2。

カテゴリタグと特殊テンプレートの該当引数を除去する。通常のCategory置換と共通の2ウェーブで、同一ページの変更をまとめる。

### 処理順

1. **警告候補を走査**（事前確認／ワーカー）

   Category置換と同じく、構造を確認できない特殊参照などを警告として扱う。

2. **Templateの旧カテゴリタグを除去**（ウェーブ1／人／ワーカー）

   旧カテゴリのTemplateメンバーを先に集め、他種別の該当ルールもまとめて確認・保存する。

3. **使用ページの再計算**（中間処理／ワーカー）

   実際に編集したTemplateの呼び出し先を、設定に従いpurgeまたはnull editする。

4. **通常メンバーからタグを除去**（ウェーブ2／人／ワーカー）

   再取得した旧カテゴリメンバー（Template以外）と特殊テンプレートの構造一致を同じ第2ウェーブへ統合する。

5. **特殊テンプレートの引数を除去**（ウェーブ2・後処理／人／ワーカー）

   通常タグの削除に続けて、該当する所属カテゴリ引数を削除・再番号付けする。同じページなら一度の編集。任意で最後に残存候補をpurgeする。

### 具体例

変更前:

```text
本文
[[Category:旧]]
```

変更後:

```text
本文
```

通常のカテゴリタグと、その前の改行を対象に除去する。特殊引数の処理は構造を読んで行う。

### 確認点

- Categoryページそのものを削除する機能ではない。
- fixCategoryLinksによる一般文字列の置換・検索対象追加はCategory置換専用。Category除去には使わない。

### 実装の根拠

- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `runTask`
- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `categoryRemoveSteps`
- [src/worker/redirectCategoryTemplate.js](../src/worker/redirectCategoryTemplate.js) — `removeCategoryFromTemplate`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-template"></a>

## 8. テンプレート置換

分類: 置換作業。ウェーブ: 2。

テンプレートの呼び出し名を変える。リンク置換等と同じタスクに入れれば、同じ通常ページへの変更を一度の編集にまとめる。

### 処理順

1. **使用ページを取得**（ウェーブ1／対象取得）

   embeddedinを指定名前空間で取得する。Templateも含む指定ならその部分を第1ウェーブで先に処理する。省略時は標準名前空間なので第1ウェーブは0件。

2. **本文を取得して呼び出し名を変換**（変換／ワーカー）

   Template対象がある場合は他のルールとまとめて呼び出し名を変換・確認・保存し、設定に従いその呼び出し先を更新する。

3. **差分確認・承認**（確認／人／ワーカー）

   通常ページのembeddedinを取り直し、リンク置換等が取得した同じページと統合してひとつの新本文を確認する。

4. **保存して記録**（編集／ワーカー）

   通常ページを保存して記録する。設定があれば旧テンプレートの使用ページ等の残存候補も再取得してpurgeする。

### 具体例

変更前:

```text
{{旧|引数=値}}
```

変更後:

```text
{{新|引数=値}}
```

from=旧、to=新。

### 確認点

- 対象はembeddedinで取得できたページ。指定外の名前空間は処理しない。

### 実装の根拠

- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `resolveRuleTargetsForStage`
- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `templateRenameSteps`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-unlink"></a>

## 9. リンク解除

分類: 置換作業。ウェーブ: 2。

ページへの内部リンクを外し、表示名または元ページ名を本文として残す。

### 処理順

1. **リンク元を取得**（ウェーブ1／対象取得）

   backlinksを指定名前空間で取得する。Templateを選んでいれば先にその部分を処理し、呼び出し先更新後に通常ページを取り直す。

2. **表示名付きリンクを先に解除**（変換／ワーカー）

   [[旧#節|表示名]]を表示名へ変える。表示名のない[[旧]]や[[旧#節]]は旧へ変える。

3. **一覧型ハットノートを構造編集**（構造編集／ワーカー）

   See also、Seealso、See、Main、混同の該当ページ引数を除く。引数がなくなった呼び出しは削除し、単独行ならその行も除く。

4. **差分確認・編集**（編集／人／ワーカー）

   他種別の変更も含む同じ新本文を確認して保存する。設定に応じ最後に残る参照候補をpurgeする。ページ自体は削除しない。

### 具体例

変更前:

```text
[[旧|表示]] / [[旧#節]]
```

変更後:

```text
表示 / 旧
```

リンク先のページや節を削除する操作ではない。

### 確認点

- OtherusesやForのように引数の役割が異なる呼び出し、名前付き引数のある一覧型呼び出しはハットノート除去の対象外。

### 実装の根拠

- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `unlinkPageSteps`
- [src/worker/hatnoteUnlink.js](../src/worker/hatnoteUnlink.js) — `removePageFromHatnotes`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `applyRedirectCategoryTemplateEdits`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-subst"></a>

## 10. テンプレートのsubst化

分類: 置換作業。ウェーブ: 2。

呼び出しにsubst:を付け、保存時にMediaWiki側で展開する。

### 処理順

1. **使用ページを取得**（ウェーブ1／対象取得）

   embeddedinから取得する。Templateも選んでいればTemplate優先、呼び出し先更新、通常ページという共通の順で進む。

2. **subst:を付ける**（変換／ワーカー）

   {{旧|…}}を{{subst:旧|…}}へ変換する。既存のsubst:やsafesubst:を重ねて付けることはしない。

3. **保存前の本文を確認**（確認／人／ワーカー）

   準備済み本文ではsubst指定の追加を確認する。準備段階で展開済みの最終本文を保存しているわけではない。

4. **保存時に展開**（編集／MediaWiki）

   承認後に送ったsubst指定はMediaWikiが保存時に処理する。保存後の版や表示は必要に応じてウィキで確認する。

### 具体例

変更前:

```text
{{旧|引数}}
```

変更後:

```text
{{subst:旧|引数}}
```

「変更後」は送信前の本文。展開後の保存結果そのものではない。

### 確認点

- 他種別と同じ共通2ウェーブで処理する。通常ページのTemplate置換やリンク修正とも同じ編集にまとめる。

### 実装の根拠

- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `templateSubstSteps`
- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `resolveRuleTargetsForStage`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-url"></a>

## 11. 外部リンクの付け替え

分類: 置換作業。ウェーブ: 2。

URLの境界を確認して付け替え、Templateを先に処理した後に対象を取り直す。

### 処理順

1. **対象URLの検索条件を作る**（設定／対象取得）

   末尾が/ならその配下、末尾が/でなければURL本体と/・?・#が続く範囲を対象とする。bothSchemes有効時はhttpとhttpsの検索結果を統合する。

2. **Templateの使用ページを検索**（ウェーブ1／人／ワーカー）

   Template名前空間のexturlusage候補を他種別とまとめて編集する。設定が有効なら編集したTemplateの呼び出し先を更新する。

3. **その他の指定範囲を再検索**（ウェーブ2／対象取得）

   呼び出し先更新後にexturlusageを再照会する。指定名前空間からTemplateを除き、他種別の通常ページ候補と統合する。

4. **URLを変換して保存**（編集／人／ワーカー）

   境界に合うURLを変換し、他種別の変更も含む差分を確認・保存する。設定があれば最後に残る旧URLの参照候補を再取得してpurgeする。

### 具体例

変更前:

```text
http://old.example/a?x=1
```

変更後:

```text
https://new.example/a?x=1
```

from=http://old.example/、to=https://new.example/ の例。

### 確認点

- bothSchemesは画面では既定オンだが、対象取得関数の省略時引数はfalse。設定値を明示して読む。
- 別ホスト名の一部や、/pageに対する/page2のような境界外は変更しない。

### 実装の根拠

- [src/worker/targetResolvers.js](../src/worker/targetResolvers.js) — `resolveExtUrlUsage`
- [src/worker/templatePresets.js](../src/worker/templatePresets.js) — `urlRenameSteps`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-custom"></a>

## 12. カスタム正規表現

分類: 置換作業。ウェーブ: 2。

自分で指定した取得方法とJavaScript正規表現のステップを使う。

### 処理順

1. **対象を決める**（取得／人／対象取得）

   指定の取得方法で候補を集め、Template／通常ページへ振り分ける。手入力等で名前空間が不明な候補はページ情報で確認する。確認できなければ誤ったウェーブで編集せず取得処理を止める。

2. **保護領域をマスク**（準備／ワーカー）

   nowiki・pre・コメント等をWikitextParser.protectRegionsで一時的に保護する。

3. **上から順番に置換**（変換／ワーカー）

   各ステップをnew RegExpで作り、前ステップの結果へ次ステップを適用する。$1等の置換参照を利用できる。loopUntilStable指定は変化が止まるか最大50回まで反復する。

4. **保護領域を復元して判定**（判定／ワーカー）

   復元した本文が元と同じならスキップ、変化があれば差分確認へ進む。増大して220万文字を超える結果は例外にして準備失敗とする。

5. **確認・編集**（編集／人／ワーカー）

   他種別の一致ルールと共通の2ウェーブで処理する。Templateを編集した場合の呼び出し先更新も共通。最後の残存候補purgeは自動取得の候補だけを再取得し、手入力・固定対象は除く。

### 具体例

変更前:

```text
旧い表記A → 中間表記B
```

変更後:

```text
新しい表記C
```

ステップ1でA→B、ステップ2でB→Cとすると、同じ準備処理中にA→Cまで進む。

### 確認点

- insource検索のエラーは0件＋警告として返す経路がある。検索失敗を全タスク失敗と決めつけない。
- 手入力にはAPI取得の5000件上限を適用する同じリスト関数は通らない。上限の説明を一律にしない。

### 実装の根拠

- [src/worker/targetResolvers.js](../src/worker/targetResolvers.js) — `resolveTargetSource`
- [src/worker/regexEngine.js](../src/worker/regexEngine.js) — `applyReplacementSteps`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `buildNewWikitext`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-mixed"></a>

## 13. 複数ルールを同じタスクへ入れた場合

分類: 共通。ウェーブ: 共通・個別処理。

種別ごとに作業段階を分けず、タスク全体のTemplate／通常ページという2段階で同じページへの変更をまとめる。

### 処理順

1. **タスク全体の段階を決める**（設定／ワーカー）

   通常タスクは共通2ウェーブ、全ルールが固定対象の再試行・取り消しなら1ウェーブ。旧バージョンのタスクだけは従来の最大ウェーブ数を使う。

2. **そのウェーブで有効なルールだけ列挙**（取得／対象取得）

   通常タスクではすべての種別を両ウェーブで評価し、名前空間で分ける。Templateに適用しない名前空間設定のルールは第1ウェーブでは対象を持たない。

3. **同一タイトルをまとめる**（集約／ワーカー＋DB）

   同じウェーブで複数ルールが同じページを取得したら1つのtask_pagesへ統合し、matched_rule_indicesに該当ルールの番号を保存する。

4. **紐づいたルールを順番に適用**（変換／ワーカー）

   設定配列順に正規表現ステップを実行した後、紐づいたルール順に構造編集を行う。他ルールが取得しただけのページへ、すべてのルールを無条件に適用するわけではない。

5. **次のウェーブでも必要なら再処理**（反復／ワーカー）

   Templateは第1ウェーブ、通常ページは第2ウェーブへ固定する。カテゴリタグと所属カテゴリ引数も第2ウェーブで統合するので、この違いによる再編集を避ける。

### 確認点

- 進捗の分母はウェーブごとの作業行を足す。ユニークなページ数や実編集回数とは一致しないことがある。
- カスタムA→BとB→Cの両方を同じページへ適用するには、そのページが両方の取得対象に入っている必要がある。

### 実装の根拠

- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `runTask`
- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `enumerateStageIfNeeded`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `buildNewWikitext`
- [src/worker/globalWaves.js](../src/worker/globalWaves.js) — `resolveGlobalTargets`

<a id="work-link-update"></a>

## 14. 呼び出し先のリンク表更新：purge／null edit

分類: 中間・復旧。ウェーブ: 共通・個別処理。

種別を問わず、Templateを編集した後、その呼び出し先のリンク表・カテゴリ所属の再計算を促す。

### 処理順

1. **使用ページ一覧を保存**（準備／ワーカー）

   第1ウェーブでeditedとなった全Templateのembeddedinを全名前空間で取得する。重複を除き、専用のtemplateRefreshに更新対象一覧と進捗を保存する。

2. **1件または50件ずつ送る**（更新／Botクライアント）

   既定はpurge＋forcelinkupdateで呼び出し先を最大50件ずつ更新する。選択によりnull editを1件ずつ行う。更新自体を無効にすることもできる。通常の差分承認は挟まない。

3. **更新間隔と停止を確認**（反復／ワーカー）

   操作間はnullEditIntervalMs（既定1秒）だけ待つ。各バッチ前に緊急停止・中止を調べる。purgeのratelimitedは既定60秒待って1回やり直す。

4. **進捗を保存**（記録／ワーカー＋DB）

   バッチごと（null editは1件ごと）に進捗を保存し、再開はその続きから行う。通信と保存の間で中断された場合は最後の更新が重なる可能性がある。

5. **完了印を付ける**（完了／ワーカー）

   個別失敗は警告として記録し、completeと件数を残す。通常ページを取り直してまとめ編集する。最後の残存候補purgeは別のremainingRefreshで再取得・進捗を管理する。

### 確認点

- purge先は呼び出し先。Template本体のpurgeを呼び出し先更新の代用にはしない。
- purgeは再計算を促す処理で、索引・リンク表が全て即時に最新になることや残存候補が0件になることを保証しない。
- 残存候補の再purgeは一度だけ。参照が消えるまで反復する処理ではない。

### 実装の根拠

- [src/worker/linkRefresh.js](../src/worker/linkRefresh.js) — `refreshTemplateCallers`
- [src/worker/linkRefresh.js](../src/worker/linkRefresh.js) — `purgeRemainingTargets`
- [src/bot/mwClient.js](../src/bot/mwClient.js) — `purgeWithLinkUpdate`

<a id="work-failure"></a>

## 15. 編集失敗・編集競合・自動再試行

分類: 中間・復旧。ウェーブ: 共通・個別処理。

クライアント内の再試行とページ処理側の再試行を分けて読む。

### 処理順

1. **クライアント内で処理**（内側／Botクライアント）

   maxlagやHTTP 429はRetry-Afterまたは既定5秒を使い最大5回再試行。認証切れの既知コードは再ログインして1回だけ再実行する。

2. **ページ処理側で分類**（判定／ワーカー）

   内側から返った失敗を分類する。編集競合、レート制限、readonly、maxlag、lockmanager-fail-conflict、internal_api_error系、5xx・429・通信系等は再試行候補。保護やブロック等は通常その場で失敗となる。

3. **上限を先に判定**（分岐／ワーカー）

   再試行上限（既定3回）に達したか、再試行対象外ならfailedとedit_logを記録する。再試行回数0では後続の手動競合の再確認や取り消し専用分岐にも進まない。

4. **競合の種類で分ける**（競合／ワーカー）

   再試行枠があるとき、一括取り消しの競合はスキップ、手動確認の競合は最新版で作り直して再確認、自動モードの競合は待機後に最新版で作り直す。

5. **待機して再実行**（再試行／ワーカー）

   通常は10秒→20秒→40秒。ページ表示はeditingのまま理由を表示する。待機中は最大1秒刻みで停止・中止を調べる。競合以外の再試行では準備済み本文を使う。

6. **失敗時の方針へ進む**（終了／ワーカー）

   最終的に失敗したらpauseでタスク一時停止、skipAndContinueならfailedを残して後続を処理する。準備失敗はこの外側の編集再試行ループを通らない。

### 分岐

- **競合後に変更不要**: skippedとして続ける。
- **再試行待機中に停止**: 追加編集せずapprovedへ戻す。再開時に本文を再準備する。

### 確認点

- 「最大3回」はページ処理側の再試行回数で、内部API呼び出し回数全体の上限ではない。
- 通信例外の再試行も実装されている。送信済み編集の結果が不明な場合は履歴・ログで照合し、絶対に重複しないと説明しない。

### 実装の根拠

- [src/worker/pipeline.js](../src/worker/pipeline.js) — `isRetryableEditError`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `editOnePage`
- [src/bot/mwClient.js](../src/bot/mwClient.js) — `withSessionRetry`
- [src/bot/mwClient.js](../src/bot/mwClient.js) — `MAX_LAG_RETRIES`

<a id="work-resume"></a>

## 16. 一時停止・途中変更・中止・期限切れ・再開

分類: 中間・復旧。ウェーブ: 共通・個別処理。

同じタスクの未処理分を再開する操作と、すでに失敗したページの再試行を分ける。

### 処理順

1. **停止理由を確定**（停止／人／ワーカー）

   手動の一時停止は実行中ならpause_requestedを立てる。保存中・先読み中の処理終了後、worker_activeを落としてpausedを確定する。待機中なら即停止。緊急停止・失敗時pause・期限切れ・中止は従来の各状態を使う。

2. **必要なら全体停止を解除**（解除／人）

   緊急停止フラグの解除はownerだけが行う。解除だけではemergency_stoppedになったタスクを自動再開しない。

3. **必要なら対象・設定を変更**（途中変更／人／Webサーバー）

   停止完了後、ページの追加・除外・除外解除、置換ルール・編集設定を保存できる。未処理の差分・承認・候補・purge計画を破棄し、編集済みなどの確定結果と履歴を保持する。追加ページには全ルールを適用する。 対象はリンク元・テンプレート使用ページなどから検索して複数選択でき、名前空間・ページ名で絞った一括除外もできる。名前空間全体の除外は後続の取得とpurgeにも適用する。

4. **再開を要求**（再開／Webサーバー）

   worker_active=0かつ停止要求なしのpaused・emergency_stopped・expiredだけをqueuedへ戻し、確認期限をクリアする。同じタスクIDを使う。変更の保存だけでは再開しない。

5. **準備・確認中のページを戻す**（再準備／ワーカー）

   パイプライン開始時、preparing・prepared・awaiting_review・approvedはpendingへ戻し、最新版から準備し直す。edited・skipped・rejected・failedを一括で未処理へ戻さない。

6. **残りを処理**（続行／ワーカー）

   変更なしなら既存の列挙・purge進捗から続行。対象・設定を変更したなら各ウェーブの候補を再取得し、除外・追加指定を反映。編集済み・変更なし・却下・失敗は自動で再編集しない。未編集の失敗等は明示追加で再試行できる。

### 確認点

- 中止・停止は、すでに実行済みの編集を巻き戻さない。取り消したい場合は別の一括取り消しタスクを作る。
- 待機・通信のすべてに即時キャンセル機構があるわけではない。停止後は実際の状態と履歴を確認する。

### 実装の根拠

- [src/routes/tasks.js](../src/routes/tasks.js) — `'/api/tasks/:id/resume'`
- [src/routes/emergency.js](../src/routes/emergency.js) — `router.post`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `resetInterruptedPages`
- [src/services/taskControls.js](../src/services/taskControls.js) — `createTaskControls`
- [src/worker/taskControl.js](../src/worker/taskControl.js) — `releaseTask`

<a id="work-recovery"></a>

## 17. ワーカー再起動からの復旧

分類: 中間・復旧。ウェーブ: 共通・個別処理。

実行中のまま取り残されたタスクを起動時に復旧する。

### 処理順

1. **runningの残存タスクを取得**（起動／ワーカー）

   単一ワーカー運用を前提に、起動時のrunningを前回の中断タスクとして調べる。

2. **短時間の再起動履歴を数える**（判定／ワーカー）

   直近60分の「キューへ戻した」ログが2件以上なら、そのタスクを再び戻さずfailedにする。3回目の中断で後のタスクを止め続けないための処理。

3. **キューへ戻す**（復旧／ワーカー＋DB）

   通常はrunningをqueuedへ戻してログを残す。その後は通常の古い待機タスク取得へ合流する。

4. **未確定ページを整理**（ページ復旧／ワーカー）

   preparing・prepared・awaiting_review・approvedはpendingへ戻す。editingのまま残るページは結果不明としてfailedにし、無条件で編集を再送しない。

5. **履歴で結果を確認**（照合／人）

   編集中断ページはページ履歴で実際の保存結果を確認する。必要なら別の失敗ページ再試行タスクを作る。

### 確認点

- 復旧時にfailedとなったediting行は、通常の編集失敗と同じedit_log書き込み関数を通るわけではない。task_pagesの理由も見る。

### 実装の根拠

- [src/worker/recovery.js](../src/worker/recovery.js) — `requeueInterruptedTasks`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `resetInterruptedPages`
- [worker.js](../worker.js) — `mainLoop`

<a id="work-retry-failed"></a>

## 18. 失敗ページだけを新規タスクで再試行

分類: 中間・復旧。ウェーブ: 1。

元タスクの成功済みページを集め直さず、記録に残る失敗タイトルだけを処理する。

### 処理順

1. **失敗タイトルを集める**（取得／Webサーバー）

   edit_logのfailedとtask_pagesのfailedをUNIONし、タイトルを重複除去する。準備失敗はtask_pagesにしかない場合がある。

2. **元設定を引き継ぐ**（設定／Webサーバー）

   元の全ルールへ同じ失敗タイトル一覧をforceTargetsとして付ける。アカウント、確認モード、編集設定、失敗時方針を引き継ぐ。

3. **新しいタスクを作る**（登録／Webサーバー＋DB）

   別のタスクIDでqueued登録し、retry_of_task_idへ元タスクIDを保存する。元タスクを直接変更しない。

4. **1ウェーブで再処理**（再処理／ワーカー）

   通常のbacklinks等の解決を迂回し、固定タイトルを最新本文から準備する。全ルールへ同じforceTargetsが付くため、元と同じmatched_rule_indicesを厳密に復元する方法ではない。

5. **差分確認・保存**（編集／人／ワーカー）

   現在は修正不要なページならスキップする。再失敗時も新しいタスクのログで確認する。

### 確認点

- これは「再開」と異なる。すでにfailedとなったページを対象にする。
- task_pages削除後は、edit_logに残っていない準備失敗や編集中断のタイトルを、このAPIだけでは拾えない。
- CategoryルールでもforceTargets付きは1ウェーブ。通常の2ウェーブや呼び出し先更新を自動的に再現しない。

### 実装の根拠

- [src/routes/tasks.js](../src/routes/tasks.js) — `'/api/tasks/:id/retry-failed'`
- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `ruleStageCount`
- [src/worker/taskRunner.js](../src/worker/taskRunner.js) — `resolveRuleTargetsForStage`

<a id="work-revert"></a>

## 19. 編集の一括取り消し

分類: 中間・復旧。ウェーブ: 1。

元タスクが行った編集を成功ログから選び、確認・保存するための別タスクを作る。

### 処理順

1. **編集済みログを集計**（取得／Webサーバー）

   実行中・待機中以外の許可状態から、editedのedit_logを古い順で読む。ページ単位に最初の編集前版、最後の編集版、途中の各編集をまとめる。

2. **取り消し専用タスクを作成**（登録／Webサーバー）

   revertEditsルールへ固定対象とuseUndoを設定する。元アカウント・編集設定を引き継ぎ、失敗時はskipAndContinue。通常の対象検索や複数ウェーブは行わない。

3. **現在版と対象版を比較**（準備／ワーカー）

   現在版が元タスクの最後の編集版で、各編集が連続しているなら、最初の編集前の本文を取得する。

4. **後続・割り込み編集を扱う**（統合／ワーカー）

   他の編集があれば、useUndoなしではスキップ。有効なら対象編集を新しい順に除く行単位の3者マージを試す。取得不能・統合競合・既に取り消し済みなら理由付きでスキップする。

5. **取り消し差分を確認**（確認／人／ワーカー）

   通常の確認モードで、現在本文から取り消し後本文への差分を確認する。useUndoを選んだから必ず保存できるわけではない。

6. **競合確認付きで保存**（編集／ワーカー）

   準備時刻を付けて編集する。準備後の競合は再試行枠があるとき専用のスキップ分岐へ入る。枠がなければ失敗扱いの先行判定になる。

### 確認点

- 逆方向の文字列置換ではない。版の本文や3者マージを用いる。
- 取り消しも新しい編集として履歴へ残る。元の版を履歴から消す操作ではない。

### 実装の根拠

- [src/routes/tasks.js](../src/routes/tasks.js) — `buildRevertTargets`
- [src/worker/pipeline.js](../src/worker/pipeline.js) — `prepareRevert`
- [src/worker/undoMerge.js](../src/worker/undoMerge.js) — `undoEdits`

<a id="work-botreq-import"></a>

## 20. Bot作業依頼の読み込み・分類・取り込み

分類: 作業依頼。ウェーブ: 共通・個別処理。

依頼のテンプレートを読んで置換ルール案を作る。取得だけでは編集やタスク作成をしない。

### 処理順

1. **依頼本文と進捗を取得**（読み取り／Webサーバー）

   依頼ページ、topic list、依頼ごとの節情報を取得する。threadId指定なら該当依頼だけを取り込む。

2. **改名元と改名先のペアを分類**（分類／Webサーバー）

   DELETE_PAGEはリンク解除、Template→subst:はsubst化、URL同士は外部リンク、節・表示名指定、Category同士、Template同士、通常リンク等へ分類する。条件不整合は未対応として表示する。

3. **リダイレクト先を解決**（解決／Webサーバー）

   REDIRECT_TARGETは取得時点の解決先で通常の分類をやり直す。ページ名の正規化や節付きの解決先も画面へ示す。

4. **人が取り込む案を確認**（確認／人）

   未対応ペアは自動でルールに取り込まない。対応したペアを明示的に選び、必要なら通常画面で直す。

5. **タスクを作成**（登録／人／Webサーバー）

   依頼への紐づけと作業記録のBot要約を引き継ぎ、設定を確認して通常のqueuedタスクを作る。

### 確認点

- リダイレクト先は取り込み時点で固定され、その後の変更には自動追従しない。
- タスク完了と、依頼への完了記録・解決済みの保存は別操作。

### 実装の根拠

- [src/routes/botreq.js](../src/routes/botreq.js) — `'/api/botreq/proposals'`
- [src/worker/botreq.js](../src/worker/botreq.js) — `resolveRedirectTargets`
- [src/services/botreqDesk.js](../src/services/botreqDesk.js) — `requestSections`

<a id="work-botreq-start"></a>

## 21. Bot作業依頼：着手を記録

分類: 作業依頼。ウェーブ: 共通・個別処理。

作業記録の件数を進め、依頼名・作業者・依頼へのリンク・Bot編集要約を持つ着手記録を作る。作業記録がなければ新規作成する。

### 処理順

1. **現在の依頼と作業記録を読む**（取得／Webサーバー）

   節IDから依頼を特定し、依頼本文・関連する年の作業記録・必要な情報を取得する。

2. **着手する本文案を作る**（準備／Webサーバー）

   作業記録の件数を進め、依頼名・作業者・依頼へのリンク・Bot編集要約を持つ着手記録を作る。作業記録がなければ新規作成する。

3. **プレビュー・差分・要約を確認**（確認／人）

   prepare、render、diffは保存ではない。本文や要約を編集し、返信する場合はコメントも確認して「保存」を押す。

4. **まず本文を保存**（保存／Webサーバー）

   保存対象に応じたBotPasswordアカウントでaction=editする。既存ページはnocreateとbasetimestamp、新規作業記録はcreateonlyを使う。通常タスクのワーカーキューへ入れる処理ではない。

5. **任意の返信を後から投稿**（返信／Webサーバー）

   本文保存成功の後、comment指定があれば同じclientでdiscussiontoolseditによる返信を試す。返信失敗でも本文は残り、comment.ok=falseを返す。解決の通常生成案にはcommentを付けない。

6. **保存結果を確認**（照合／人）

   本文の版IDと返信の成否を別々に確認する。返信だけ失敗した場合、本文全体をむやみに再保存せず、依頼の現状を確認する。

### 分岐

- **本文保存が競合**: 409を表示し、現状を読み直して操作をやり直す。
- **新規作成先が既に存在**: createonlyの失敗として扱い、読み直す。
- **本文成功・返信失敗**: 保存全体を巻き戻すトランザクションではない。結果を区別して表示する。

### 確認点

- 本文は対象に応じてBOTREQ_LOG_ACCOUNTまたはBOTREQ_ACCOUNTのclientで保存する。現行saveWithは任意返信にもその同じclientを使う。prepareが返すcommentAccountの表示（BOTREQ_ACCOUNT）と実際のclientが異なる場合があるため、返信者は保存後に確認する。
- 緊急停止の通常タスク用フラグは、この保存経路では判定していない。停止すれば全種類のウィキ書き込みが一律に禁止されるとは扱わない。

### 実装の根拠

- [src/services/botreqDesk.js](../src/services/botreqDesk.js) — `prepare`
- [src/services/botreqDesk.js](../src/services/botreqDesk.js) — `saveWith`
- [src/routes/botreq.js](../src/routes/botreq.js) — `'/api/botreq/save'`

<a id="work-botreq-complete"></a>

## 22. Bot作業依頼：完了を記録

分類: 作業依頼。ウェーブ: 共通・個別処理。

投稿記録とタスクの編集ログを版IDで照合し、件数や期間、タスク別内訳を持つ完了記録を作る。タスク未紐づけの編集等が混ざる場合は画面の注意も確認する。

### 処理順

1. **現在の依頼と作業記録を読む**（取得／Webサーバー）

   節IDから依頼を特定し、依頼本文・関連する年の作業記録・必要な情報を取得する。

2. **完了する本文案を作る**（準備／Webサーバー）

   投稿記録とタスクの編集ログを版IDで照合し、件数や期間、タスク別内訳を持つ完了記録を作る。タスク未紐づけの編集等が混ざる場合は画面の注意も確認する。

3. **プレビュー・差分・要約を確認**（確認／人）

   prepare、render、diffは保存ではない。本文や要約を編集し、返信する場合はコメントも確認して「保存」を押す。

4. **まず本文を保存**（保存／Webサーバー）

   保存対象に応じたBotPasswordアカウントでaction=editする。既存ページはnocreateとbasetimestamp、新規作業記録はcreateonlyを使う。通常タスクのワーカーキューへ入れる処理ではない。

5. **任意の返信を後から投稿**（返信／Webサーバー）

   本文保存成功の後、comment指定があれば同じclientでdiscussiontoolseditによる返信を試す。返信失敗でも本文は残り、comment.ok=falseを返す。解決の通常生成案にはcommentを付けない。

6. **保存結果を確認**（照合／人）

   本文の版IDと返信の成否を別々に確認する。返信だけ失敗した場合、本文全体をむやみに再保存せず、依頼の現状を確認する。

### 分岐

- **着手記録なし・着手後の編集増分なし**: 完了案の作成をエラーで止める。着手記録や対象Botの投稿記録を確認する。
- **本文保存が競合**: 409を表示し、現状を読み直して操作をやり直す。
- **新規作成先が既に存在**: createonlyの失敗として扱い、読み直す。
- **本文成功・返信失敗**: 保存全体を巻き戻すトランザクションではない。結果を区別して表示する。

### 確認点

- 本文は対象に応じてBOTREQ_LOG_ACCOUNTまたはBOTREQ_ACCOUNTのclientで保存する。現行saveWithは任意返信にもその同じclientを使う。prepareが返すcommentAccountの表示（BOTREQ_ACCOUNT）と実際のclientが異なる場合があるため、返信者は保存後に確認する。
- 緊急停止の通常タスク用フラグは、この保存経路では判定していない。停止すれば全種類のウィキ書き込みが一律に禁止されるとは扱わない。

### 実装の根拠

- [src/services/botreqDesk.js](../src/services/botreqDesk.js) — `prepare`
- [src/services/botreqDesk.js](../src/services/botreqDesk.js) — `saveWith`
- [src/routes/botreq.js](../src/routes/botreq.js) — `'/api/botreq/save'`

<a id="work-botreq-resolve"></a>

## 23. Bot作業依頼：解決を記録

分類: 作業依頼。ウェーブ: 共通・個別処理。

依頼の対象節へ解決済みの記述を追加する。完了したタスクを再実行する操作ではない。

### 処理順

1. **現在の依頼と作業記録を読む**（取得／Webサーバー）

   節IDから依頼を特定し、依頼本文・関連する年の作業記録・必要な情報を取得する。

2. **解決する本文案を作る**（準備／Webサーバー）

   依頼の対象節へ解決済みの記述を追加する。完了したタスクを再実行する操作ではない。

3. **プレビュー・差分・要約を確認**（確認／人）

   prepare、render、diffは保存ではない。本文や要約を編集し、返信する場合はコメントも確認して「保存」を押す。

4. **まず本文を保存**（保存／Webサーバー）

   保存対象に応じたBotPasswordアカウントでaction=editする。既存ページはnocreateとbasetimestamp、新規作業記録はcreateonlyを使う。通常タスクのワーカーキューへ入れる処理ではない。

5. **任意の返信を後から投稿**（返信／Webサーバー）

   本文保存成功の後、comment指定があれば同じclientでdiscussiontoolseditによる返信を試す。返信失敗でも本文は残り、comment.ok=falseを返す。解決の通常生成案にはcommentを付けない。

6. **保存結果を確認**（照合／人）

   本文の版IDと返信の成否を別々に確認する。返信だけ失敗した場合、本文全体をむやみに再保存せず、依頼の現状を確認する。

### 分岐

- **本文保存が競合**: 409を表示し、現状を読み直して操作をやり直す。
- **新規作成先が既に存在**: createonlyの失敗として扱い、読み直す。
- **本文成功・返信失敗**: 保存全体を巻き戻すトランザクションではない。結果を区別して表示する。

### 確認点

- 本文は対象に応じてBOTREQ_LOG_ACCOUNTまたはBOTREQ_ACCOUNTのclientで保存する。現行saveWithは任意返信にもその同じclientを使う。prepareが返すcommentAccountの表示（BOTREQ_ACCOUNT）と実際のclientが異なる場合があるため、返信者は保存後に確認する。
- 緊急停止の通常タスク用フラグは、この保存経路では判定していない。停止すれば全種類のウィキ書き込みが一律に禁止されるとは扱わない。

### 実装の根拠

- [src/services/botreqDesk.js](../src/services/botreqDesk.js) — `prepare`
- [src/services/botreqDesk.js](../src/services/botreqDesk.js) — `saveWith`
- [src/routes/botreq.js](../src/routes/botreq.js) — `'/api/botreq/save'`

<a id="work-notifications"></a>

## 24. 状態通知と端末へのPush

分類: 後処理。ウェーブ: 共通・個別処理。

Bot処理の結果を通知する。通知そのものはタスクの承認や緊急停止の実行命令ではない。

### 処理順

1. **イベントを決める**（発生／Web／ワーカー）

   ワーカーはタスク処理から戻った後の状態を読み、paused・failed・expired・emergency_stopped・completed_with_failures・completedを通知する。緊急停止・解除はWebのAPIから別途通知する。

2. **通知経路を並行実行**（選択／通知サービス）

   メール／WebhookとPushを独立に試す。メール等は共有設定、Pushは端末ごとのイベント選択で絞る。

3. **Pushの購読条件を確認**（確認／通知サービス）

   現在のowner設定、セッションの有効性・ユーザー・role、期限、VAPID鍵、選択イベントを確認して送信候補を選ぶ。ログアウトや期限切れ後は対象外。

4. **通知を送る**（表示／Push／端末）

   Pushは暗号化ペイロードのeventをService Workerが固定文面へ変換する。ページ名・利用者名・エラー本文は表示しない。古い／未知イベントは汎用表示。

5. **通知から状態を確認**（確認／人）

   通知を開くと対象タスク等へ移る。実配送・即時表示はOS・ネットワークにも依存し、送信受付は実受信の保証ではない。

### 確認点

- キャンセルは通常イベント通知の対象外。テスト通知は現在端末専用で通常イベント選択とは独立。
- Pushの既定選択は通常のcompletedを除く7種類。メール／WebhookのNOTIFY_EVENTSでは端末の選択を変えない。

### 実装の根拠

- [worker.js](../worker.js) — `notifyTaskStatus`
- [src/services/notify.js](../src/services/notify.js) — `notify`
- [src/services/push.js](../src/services/push.js) — `sendEvent`
- [public/sw.js](../public/sw.js) — `EVENT_NOTICES`

<a id="work-cleanup"></a>

## 25. 作業データ整理と稼働記録

分類: 後処理。ウェーブ: 共通・個別処理。

タスクとタスクの合間に古い作業データを整理し、稼働状況は別タイマーで記録する。

### 処理順

1. **掃除の周期を確認**（周期／ワーカー）

   mainLoop先頭で周期を確認する。既定1時間だが、長いタスクの最中に掃除専用の別処理を割り込ませる実装ではない。

2. **対象タスクを選ぶ**（選択／ワーカー＋DB）

   completed・completed_with_failures・failed・cancelledで、最終更新から保持日数を過ぎ、task_pagesが残るタスクを最大100件選ぶ。保持日数0以下なら掃除しない。

3. **作業行を分割削除**（削除／ワーカー＋DB）

   各タスクのtask_pagesを既定1000行ずつ削除し、task_logsに削除件数を残す。prepared本文やページ単位の状態はここで失われる。

4. **恒久ログを保持**（保持／ワーカー）

   tasks、edit_log、task_logs、task_warningsはこの掃除では削除しない。再開可能なpaused・emergency_stopped・expiredも対象外。ファイルログの保持とは別の仕組み。

5. **稼働状況を記録**（監視／ワーカー）

   別の10秒タイマーで開始時刻・状態・タスクID等をheartbeatへ書く。画面はこの鮮度から稼働状況を判断する。

### 確認点

- 保持日数はコード既定14日。画面設定→環境変数→既定値の順で決まるので、実環境の設定を確認する。
- 掃除失敗で通常のタスクループは止めず、次の周期で再び試す。

### 実装の根拠

- [worker.js](../worker.js) — `cleanupIfDue`
- [worker.js](../worker.js) — `writeHeartbeat`
- [src/worker/cleanup.js](../src/worker/cleanup.js) — `cleanupOldTaskPages`

## 動きで追う説明

### 先読み：Bは変更なし、Cを準備

各コマは説明用で、実際の所要時間を示さない。

1. **Aの準備を始める**: 候補は登録順にA、B、C。まずAを準備する。
   A：本文取得・変換 ／ B：待機 ／ C：待機
1. **Aの確認中にBを準備**: Aの差分を人が確認している間、Bを裏で準備する。編集を並列実行するわけではない。
   A：確認待ち ／ B：本文取得・変換 ／ C：待機
1. **Bを飛ばしてCまで先読み**: Bは元本文と同じなのでスキップを確定し、Cを準備する。
   A：確認待ち ／ B：スキップ（変更なし） ／ C：準備中
1. **Cは準備完了で待つ**: Cは変更あり。次の編集候補が1件見つかったので先読みを止める。Cの事前承認・却下も可能。
   A：確認待ち ／ B：スキップ確定 ／ C：準備完了
1. **Aを承認して編集**: 承認後にAを保存する。Cの準備済み本文はDBに保持される。
   A：編集中 ／ B：スキップ確定 ／ C：準備完了
1. **間隔を待ち、Cへ進む**: Aの編集処理後から間隔の残りを待つ。順番が来たCは確認待ちへ入り、自動承認ならこの時点から待機秒数を数える。
   A：編集済み ／ B：スキップ確定 ／ C：確認待ち

### Category：全体2ウェーブと呼び出し先purge

各コマは説明用で、実際の所要時間を示さない。

1. **まず警告を走査**: 特殊テンプレートの記述などを調べ、要手動確認を記録する。
   Template：未取得 ／ 使用ページ：未取得 ／ 通常・特殊参照：未取得
1. **ウェーブ1：Templateを編集**: 旧カテゴリのTemplateメンバーを先に直し、他の種別と同じページならまとめて保存する。
   Template：確認・編集 ／ 使用ページ：待機 ／ 通常・特殊参照：未取得
1. **中間処理：使用ページを再計算**: 編集したTemplateの呼び出し先をpurge（またはnull edit）し、リンク表やカテゴリ所属の再計算を促す。
   Template：編集済み ／ 使用ページ：再計算 ／ 通常・特殊参照：未取得
1. **ウェーブ2：通常タグも所属カテゴリもまとめる**: 再取得したメンバーと構造一致の特殊参照、他種別の候補を統合する。同じページは一度の確認・編集。
   Template：編集済み ／ 使用ページ：更新処理済み ／ 通常ページ＋特殊参照：まとめ編集
1. **任意：残る参照候補を再purge**: 設定がオンなら旧リンク元・旧カテゴリメンバー・旧テンプレートの使用ページ等を再取得して一度だけpurge。
   Template：完了 ／ 呼び出し先：更新処理済み ／ 残存参照候補：任意のpurge
1. **ページ失敗を集計**: task_pagesのfailed有無で最終状態を決める。警告や再計算失敗は別途ログで読む。
   本編集：結果確定 ／ 再計算：警告を確認 ／ タスク：完了または一部失敗

### 手動確認後の編集競合

各コマは説明用で、実際の所要時間を示さない。

1. **古い版から準備**: 版100を元に新本文を準備し、差分を表示する。
   Bot：版100で準備 ／ 人：差分確認中 ／ ウィキ：版100
1. **他の編集が入る**: 確認中に別の人が保存し、ウィキは版101になる。
   Bot：版100のまま ／ 人：旧差分を確認 ／ ウィキ：版101
1. **承認後に競合を検出**: 準備時刻を付けた保存でeditconflictが返る。以下は再試行枠が残っている手動モードの例。
   Bot：保存を拒否された ／ 人：承認済み ／ ウィキ：版101のまま
1. **最新版から作り直す**: 版101を取り直し同じルールを再適用する。修正済みで変化がなければスキップ。
   Bot：版101で再準備 ／ 人：再確認待ち ／ ウィキ：版101
1. **新しい差分を再確認**: 変化がある場合は確認待ちへ戻る。以前の承認で新しい差分をそのまま保存しない。
   Bot：確認待ち ／ 人：新差分を再承認 ／ ウィキ：版101
1. **承認後に再び保存**: 再度競合する可能性もある。ここでは保存成功ならeditedとなりログに記録する。
   Bot：編集済み ／ 人：結果確認 ／ ウィキ：新しい版

### 緊急停止からの再開

各コマは説明用で、実際の所要時間を示さない。

1. **タスクが確認待ち**: Aは編集済み、Bは確認待ち、Cは先読み済みの例。
   A：編集済み ／ B：確認待ち ／ C：準備完了
1. **全体停止を実行**: 停止点で検知しタスクを中断する。Aの保存結果は取り消されない。
   A：編集済みのまま ／ B：未処理で保持 ／ C：先読みを終了
1. **停止フラグだけを解除**: ownerが解除する。これだけでは中断タスクを自動再開しない。
   全体停止：解除済み ／ タスク：緊急停止のまま ／ 人：再開判断
1. **タスクを再開**: 同じタスクをqueuedへ戻す。ワーカーの順番が来たら準備し直す。
   A：編集済みのまま ／ B：pendingへ戻す ／ C：pendingへ戻す
1. **最新版で再確認**: 未処理分の本文を取り直して確認する。failedは残るので、必要なら別タスクで再試行する。
   A：再編集しない ／ B：最新版で確認 ／ C：最新版で再準備


## この資料の更新方法

本文データは `docs/assets/bot-workflows.json`、HTMLの表示は `scripts/templates/bot-workflows.html`、組み合わせ表示は `scripts/templates/workflow-composer.js` で管理する。Python 3とNode.jsで生成し、`scripts/workflow-reference.js`が実装の変換関数で置換例を照合して内部パターンを生成する。実装変更後は説明・確認日・参照コミットを見直してから次を実行する。

```sh
python3 scripts/generate-bot-workflows.py
python3 scripts/generate-bot-workflows.py --check
```

生成処理は参照先のファイル・識別子、置換例の実装との一致、生成結果を検査する。組み合わせの対象分割は `test/workflowDocs.test.js` で実際の対象抽出分岐と照合する。説明の意味や本番の取得結果を自動で保証するものではない。

```sh
node test/workflowDocs.test.js
# PlaywrightとChromiumを別途用意した環境:
PLAYWRIGHT_MODULE_PATH=/path/to/playwright node scripts/check-workflow-docs-ui.js
```

ブラウザ確認はスマホ・PC、既存の手順表示と説明再生、組み合わせ、印刷、JavaScript無効時、ローカルHTMLのオフライン利用を対象にする。

関連: [置換ルール](rule-types.md)、[状態とライフサイクル](task-lifecycle.md)、[作業依頼](botreq.md)、[運用手順](operations.md)。
