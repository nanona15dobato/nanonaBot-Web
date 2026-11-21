#!/usr/bin/env python3
"""Generate the standalone HTML and Markdown guide from reviewed local data.

Usage: python3 scripts/generate-bot-workflows.py [--check]
Requires Python 3 and Node.js. No DB, browser packages or network access are needed.
"""
import argparse
import html
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'docs/assets/bot-workflows.json'
TEMPLATE = ROOT / 'scripts/templates/bot-workflows.html'


def esc(value):
    return html.escape(str(value), quote=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check generated files without writing')
    args = parser.parse_args()
    data = json.loads(DATA.read_text(encoding='utf-8'))
    compiled = subprocess.run(['node', str(ROOT / 'scripts/workflow-reference.js')],
                              input=json.dumps(data['ruleReference'], ensure_ascii=False), text=True, capture_output=True)
    if compiled.returncode:
        raise SystemExit(compiled.stderr)
    data['ruleReference'] = json.loads(compiled.stdout)
    flows = data['workflows']
    ids = [f['id'] for f in flows]
    assert len(ids) == len(set(ids)), 'Duplicate workflow IDs'
    assert len({r['id'] for r in data['ruleReference']}) == len(data['ruleReference'])
    for flow in flows + data['ruleReference']:
        assert flow.get('steps') or flow.get('examples'), flow['id']
        assert flow['sources'], flow['id']
        for source in flow['sources']:
            path = (ROOT / source['path']).resolve()
            assert path.is_relative_to(ROOT) and path.is_file(), source
            assert source['symbol'] in path.read_text(encoding='utf-8'), source
    assert len(data['revision']) == 40 and all(c in '0123456789abcdef' for c in data['revision'])
    count = sum(len(f['steps']) for f in flows)
    md = [f"# {data['title']}", '', f"実装確認日: {data['reviewed']}。基準コミット: `{data['revision']}`。", '',
          f"{len(flows)}種類の流れを、合計{count}手順に分けて説明する。", '',
          '[操作できるHTML版](bot-workflows.html)をブラウザで開くと、作業選択・手順送り・先読み等の説明再生ができる。通信せず、ファイルを直接開いて利用できる。', '',
          '## 読み方と前提', '', *[f'- {p}' for p in data['principles']], '', '## 作業一覧', '',
          '| 作業 | 分類 | ウェーブ |', '|---|---|---|']
    articles = []
    nav = []
    for index, flow in enumerate(flows, 1):
        fid, title = flow['id'], flow['title']
        wave = f"{flow['waves']}ウェーブ" if flow['waves'] else '個別処理'
        md.append(f"| [{index}. {title}](#work-{fid}) | {flow['group']} | {wave} |")
        nav.append(f'<li><a href="#{fid}" data-flow="{fid}"><span class="nav-index">{index:02}</span><span>{esc(title)}<small>{esc(flow["group"])} · {esc(wave)}</small></span></a></li>')
        parts = [f'<article class="workflow" id="{fid}" data-group="{esc(flow["group"])}">',
                 f'<header class="flow-heading"><p class="eyebrow">{index:02} / {len(flows):02} · {esc(flow["group"])} · {esc(wave)}</p><h2 tabindex="-1">{esc(title)}</h2><p>{esc(flow["summary"])}</p></header>',
                 '<div class="step-player" hidden></div>', '<h3>最初から最後まで</h3><ol class="steps">']
        for step in flow['steps']:
            parts.append(f'<li><p class="step-meta">{esc(step["phase"])} · {esc(step["actor"])}</p><h4>{esc(step["title"])}</h4><p>{esc(step["detail"])}</p></li>')
        parts.append('</ol>')
        if flow.get('example'):
            ex = flow['example']
            parts += ['<h3>具体例</h3><div class="example">', f'<div><p>変更前</p><pre><code>{esc(ex["before"])}</code></pre></div>',
                      f'<div><p>変更後</p><pre><code>{esc(ex["after"])}</code></pre></div></div><p>{esc(ex["note"])}</p>']
        if flow['branches']:
            parts.append('<h3>分岐したとき</h3><dl class="branches">')
            for branch in flow['branches']:
                parts.append(f'<div><dt>{esc(branch["when"])}</dt><dd>{esc(branch["then"])}</dd></div>')
            parts.append('</dl>')
        if flow['checks']:
            parts.append('<h3>確認しておきたいこと</h3><ul class="checks">' + ''.join(f'<li>{esc(c)}</li>' for c in flow['checks']) + '</ul>')
        parts.append('<details class="source-list"><summary>根拠となる実装</summary><ul>')
        for s in flow['sources']:
            parts.append(f'<li><a href="../{esc(s["path"])}">{esc(s["path"])}</a> — <code>{esc(s["symbol"])}</code></li>')
        parts += ['</ul></details></article>']
        articles.append(''.join(parts))
    reference_html, extraction_html = [], []
    md += ['', '## 置換構文と対象ページの抽出', '',
           'HTML版の「構文・対象抽出」で各種別の例と内部パターン、「種別を組み合わせる」で複数種別の共通ウェーブを確認できる。', '',
           *[f'- {note}' for note in data['referenceNotes']], '']
    for rule in data['ruleReference']:
        rid, label = rule['id'], rule['label']
        parts = [f'<article class="syntax-card" id="syntax-{esc(rid)}"><h3>{esc(label)} <code>{esc(rid)}</code></h3>',
                 f'<p>{esc(rule["syntax"])}</p><h4>対象記事の抽出方法</h4><ol>',
                 *[f'<li>{esc(text)}</li>' for text in rule['extraction']], '</ol>']
        md += [f'### {label} `{rid}`', '', rule['syntax'], '', '**対象記事の抽出方法**', '',
               *[f'- {text}' for text in rule['extraction']], '']
        for i, example in enumerate(rule['examples'], 1):
            params = json.dumps(example['params'], ensure_ascii=False, indent=2)
            steps = json.dumps(example['steps'], ensure_ascii=False, indent=2)
            parts += [f'<h4>置換例 {i}</h4><div class="example"><div><p>変更前</p><pre><code>{esc(example["before"])}</code></pre></div>',
                      f'<div><p>保存へ送る本文</p><pre><code>{esc(example["after"])}</code></pre></div></div>',
                      '<details><summary>この例の設定と、実装から生成した正規表現ステップ</summary>',
                      f'<p>設定</p><pre><code>{esc(params)}</code></pre><p>本文置換ステップ</p><pre><code>{esc(steps)}</code></pre>',
                      '<p class="sim-note">構造編集はこの正規表現ステップの後に行います。上の変更後は構造編集も含めた結果です。置換例は生成時に実装と照合します。</p></details>']
            md += [f'**置換例 {i}**', '', '変更前:', '', '```text', example['before'], '```', '',
                   '保存へ送る本文:', '', '```text', example['after'], '```', '',
                   '設定:', '', '```json', params, '```', '', '実装から生成した正規表現ステップ:', '', '```json', steps, '```', '']
        parts += ['<h4>一致条件・対象外・補足</h4><ul>', *[f'<li>{esc(text)}</li>' for text in rule['notes']], '</ul>',
                  f'<p><a href="#{esc(rule["flow"])}">この種別の処理手順を追う</a> · <a href="#combine">他の種別と組み合わせる</a></p></article>']
        reference_html.append(''.join(parts))
        md += ['**一致条件・補足**', '', *[f'- {text}' for text in rule['notes']], '']
    md += ['### 抽出方法一覧', '']
    for source in data['extractionSources']:
        extraction_html.append(f'<article class="syntax-card"><h3>{esc(source["label"])} <code>{esc(source["id"])}</code></h3><pre><code>{esc(source["query"])}</code></pre><p>{esc(source["detail"])}</p></article>')
        md += [f'**{source["label"]}** (`{source["id"]}`)', '', '```text', source['query'], '```', '', source['detail'], '']
    md += ['### 複数種別を組み合わせる', '',
           'HTML版で種別を複数選び、適用順・通常名前空間・カスタムの取得元・呼び出し先更新・残存purge・確認方法を変えると、処理区間を組み直す。同じページに該当する例と別々のページに該当する例を切り替え、保存回数の違いを確認できる。実際の候補取得や編集は行わない。', '']
    for index, flow in enumerate(flows, 1):
        md += ['', f'<a id="work-{flow["id"]}"></a>', '', f'## {index}. {flow["title"]}', '',
               f'分類: {flow["group"]}。ウェーブ: {flow["waves"] or "共通・個別処理"}。', '', flow['summary'], '', '### 処理順', '']
        for n, step in enumerate(flow['steps'], 1):
            md += [f'{n}. **{step["title"]}**（{step["phase"]}／{step["actor"]}）', '', f'   {step["detail"]}', '']
        if flow.get('example'):
            ex = flow['example']
            md += ['### 具体例', '', '変更前:', '', '```text', ex['before'], '```', '', '変更後:', '', '```text', ex['after'], '```', '', ex['note'], '']
        if flow['branches']:
            md += ['### 分岐', '']
            for b in flow['branches']:
                md.append(f'- **{b["when"]}**: {b["then"]}')
            md.append('')
        if flow['checks']:
            md += ['### 確認点', '', *[f'- {c}' for c in flow['checks']], '']
        md += ['### 実装の根拠', '']
        md.extend(f'- [{s["path"]}](../{s["path"]}) — `{s["symbol"]}`' for s in flow['sources'])
    md += ['', '## 動きで追う説明', '']
    scenarios = []
    for walk in data['walkthroughs']:
        md += [f'### {walk["title"]}', '', '各コマは説明用で、実際の所要時間を示さない。', '']
        body = [f'<section class="scenario" id="frames-{walk["id"]}"><h2>{esc(walk["title"])}</h2><ol>']
        for frame in walk['frames']:
            md += [f'1. **{frame["title"]}**: {frame["body"]}', '   ' + ' ／ '.join(frame['lanes'])]
            body.append(f'<li><strong>{esc(frame["title"])}</strong><p>{esc(frame["body"])}</p><p>{esc(" ／ ".join(frame["lanes"]))}</p></li>')
        scenarios.append(''.join(body) + '</ol></section>')
        md.append('')
    footer = '''## この資料の更新方法

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
'''
    md += ['', footer.rstrip(), '']
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    replacements = {'TITLE': esc(data['title']), 'REVIEWED': esc(data['reviewed']), 'REVISION': esc(data['revision'][:12]),
                    'RULE_COUNT': str(len(data['ruleReference'])), 'COMPOSER_SCRIPT': (ROOT / 'scripts/templates/workflow-composer.js').read_text(encoding='utf-8'),
                    'REFERENCE_NOTES': ''.join(f'<li>{esc(note)}</li>' for note in data['referenceNotes']), 'RULE_REFERENCE': '\n'.join(reference_html), 'EXTRACTION_SOURCES': '\n'.join(extraction_html),
                    'COUNT': str(len(flows)), 'STEP_COUNT': str(count), 'PRINCIPLES': ''.join(f'<li>{esc(p)}</li>' for p in data['principles']),
                    'NAV': ''.join(nav), 'ARTICLES': '\n'.join(articles), 'SCENARIOS': '\n'.join(scenarios), 'DATA': payload}
    document = TEMPLATE.read_text(encoding='utf-8')
    for key, value in replacements.items():
        document = document.replace('{{' + key + '}}', value)
    outputs = {ROOT / 'docs/bot-workflows.md': '\n'.join(md), ROOT / 'docs/bot-workflows.html': document}
    for path, text in outputs.items():
        if args.check:
            if not path.exists() or path.read_text(encoding='utf-8') != text:
                raise SystemExit(f'Out of date: {path.relative_to(ROOT)}')
        else:
            path.write_text(text, encoding='utf-8', newline='\n')
    print(f'{"Checked" if args.check else "Generated"}: {len(flows)} workflows / {count} steps / {len(data["walkthroughs"])} walkthroughs')


if __name__ == '__main__':
    main()
