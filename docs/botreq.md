# Bot作業依頼（BOTREQ）からの取り込み

タスク作成画面の「Bot作業依頼から取り込む」は、[Wikipedia:Bot作業依頼](https://ja.wikipedia.org/wiki/Wikipedia:Bot作業依頼) の本文から `{{リンク修正依頼/改名}}` を探し、各ペアを置換ルールに変換して表示します（仕様書7章）。**読み込んだだけではタスクは作られません。** 内容を確認し、「対応済みのN件をルールとして取り込む」を押してから、通常どおりタスクを作成してください。

## 表示されるもの

- **topic listの依頼進捗**: `Wikipedia:Bot作業依頼/topic list` から、依頼ごとの進捗テンプレートの状態を表示します。
- **提案ごとのカード**: `{{リンク修正依頼/改名}}` の呼び出しごとに、`提案=` の内容と、ペアごとの分類結果を表示します。

`{{リンク修正依頼/改名}}` の引数は、奇数番目が改名元、偶数番目が改名先です（[Template:リンク修正依頼/改名/doc](https://ja.wikipedia.org/wiki/Template:リンク修正依頼/改名/doc) の書式）。

## ペアの分類

上から順に判定し、最初に当てはまったものになります。

| 改名元 → 改名先 | なるルール | 備考 |
|---|---|---|
| `X` → `DELETE_PAGE` | [リンク解除](rule-types.md#リンク解除-unlinkpage) | |
| `X` → `REDIRECT_TARGET` | 解決先に応じたルール | 下の「REDIRECT_TARGET」を参照 |
| `Template:X` → `subst:` | [テンプレートのsubst化](rule-types.md#テンプレートのsubst化-templatesubst) | `Template:` の無い改名元は未対応 |
| `http(s)://…` → `http(s)://…` | [外部リンクの付け替え](rule-types.md#外部リンクの付け替え-urlrename) | 片方だけURLのペアは未対応 |
| `X#節{{!}}表示` などを含む | [リンク置換（節・表示名指定）](rule-types.md#リンク置換節表示名指定-linkrenameexact) | Category/Template・ページ名が空（同じページ内の節）のものは未対応 |
| `Category:X` → `Category:Y` | [Category置換](rule-types.md#category置換-categoryrename) | |
| `Template:X` → `Template:Y` | [テンプレート置換](rule-types.md#テンプレート置換-templaterename) | |
| 片方だけ `Category:`／`Template:` | 未対応（名前空間が合わない） | |
| それ以外（通常の記事どうし） | [リンク置換](rule-types.md#リンク置換-linkrename) または [リンク置換2](rule-types.md#リンク置換2表示保持-linkrename2) | 改名元に全角括弧「（」が無く改名先にある場合はリンク置換2（表示を残す） |

未対応のペアは「[未対応: 理由]」として表示し、取り込みません。必要ならタスク作成画面で手動でルールを追加してください。

## REDIRECT_TARGET

`X → REDIRECT_TARGET` は「リダイレクトになっている X へのリンクを、リダイレクト先へ直接リンクするよう直す」という指定です。

1. 読み込み時に、X のリダイレクト先を `action=query&redirects=1` で問い合わせます（ページ名の正規化も辿ります）。
2. リダイレクト先を改名先として、上の表で分類し直します。節へのリダイレクトなら「リンク置換（節・表示名指定）」になります。
3. 画面には「[リンク置換（リダイレクト解決）] X → 解決先 ※取得時点の解決先」と表示します。

- 取り込んだ時点の解決先がルールの改名先として固定されます。その後リダイレクトが付け替えられても追従しません。取り込む前に解決先を確認してください。
- X がリダイレクトでない・存在しない場合は「未対応（REDIRECT_TARGET指定だが改名元がリダイレクトではない）」になります。
