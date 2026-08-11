#!/usr/bin/env node
'use strict';

/**
 * scripts/check-redirect-category-template.js
 *
 * 目的（仕様書8章の「要確認事項」対応）:
 *   Template:リダイレクトの所属カテゴリ の正確な引数書式を、
 *   一次資料（テンプレート自身のソース・doc・実際の使用例）から確認する。
 *
 * やること:
 *   1. Template:リダイレクトの所属カテゴリ 自体のwikitextを取得（Luaモジュールを
 *      呼んでいれば #invoke: からモジュール名を検出し、そのモジュールのソースも取得）
 *   2. Template:リダイレクトの所属カテゴリ/doc のwikitextを取得（存在すれば）
 *   3. このテンプレートを実際に使っているページを embeddedin で検索し、
 *      先頭N件について本文を取得
 *   4. 各ページ本文から WikitextParser で実際のテンプレート呼び出しを抽出し、
 *      引数の並び（argsOrdered）をそのまま表示する
 *
 * 実行方法（Toolforge上、このリポジトリのルートで）:
 *   node scripts/check-redirect-category-template.js
 *
 * 認証は不要（すべて公開情報の読み取りのみ）。ただしWikimediaのAPI利用規約により
 * User-Agentの指定が必須なので、WIKI_USER_AGENT を自分の連絡先に変更してから使うこと。
 *
 * 出力はすべてコンソールに表示し、末尾でJSONファイルにも保存する
 * （--out <path> で保存先を変更可能。既定は ./redirect-category-template-report.json）。
 */

const fs = require('fs');
const path = require('path');
const WikitextParser = require('../lib/WikitextParser');

const WIKI_HOST = process.env.CHECK_WIKI_HOST || 'ja.wikipedia.org';
const USER_AGENT =
  process.env.WIKI_USER_AGENT ||
  'NanonaBotTool-Verification/0.1 (https://ja.wikipedia.org/wiki/User:Nanona15dobato; 連絡先を書き換えてください)';
const TEMPLATE_TITLE = 'Template:リダイレクトの所属カテゴリ';
const DOC_TITLE = `${TEMPLATE_TITLE}/doc`;
const SAMPLE_PAGE_COUNT = Number(process.env.SAMPLE_PAGE_COUNT || 5);

function parseArgs(argv) {
  const out = { outPath: path.join(process.cwd(), 'redirect-category-template-report.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out.outPath = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function apiGet(params) {
  const url = new URL(`https://${WIKI_HOST}/w/api.php`);
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    throw new Error(`APIエラー (${res.status}) ${url}`);
  }
  return res.json();
}

/** ページのwikitextを取得する。存在しなければnullを返す。 */
async function fetchWikitext(title) {
  const data = await apiGet({
    action: 'query',
    prop: 'revisions',
    titles: title,
    rvslots: 'main',
    rvprop: 'content|ids|timestamp',
  });
  const page = data.query && data.query.pages && data.query.pages[0];
  if (!page || page.missing) return null;
  const rev = page.revisions && page.revisions[0];
  if (!rev) return null;
  return {
    title: page.title,
    pageid: page.pageid,
    revid: rev.revid,
    timestamp: rev.timestamp,
    wikitext: rev.slots.main.content,
  };
}

/** テンプレートを使用しているページ一覧を取得する（先頭N件、標準名前空間優先） */
async function fetchEmbeddedIn(title, limit) {
  const data = await apiGet({
    action: 'query',
    list: 'embeddedin',
    eititle: title,
    eilimit: String(limit),
    eifilterredir: 'nonredirects',
  });
  return (data.query && data.query.embeddedin) || [];
}

/** wikitext中の #invoke:ModuleName を検出する（大文字小文字・空白ゆれを許容） */
function detectInvokedModule(wikitext) {
  const m = wikitext.match(/\{\{\s*#invoke\s*:\s*([^|}]+)/i);
  return m ? `Module:${m[1].trim()}` : null;
}

function section(title) {
  console.log('\n' + '='.repeat(70));
  console.log(title);
  console.log('='.repeat(70));
}

async function main() {
  const { outPath } = parseArgs(process.argv.slice(2));
  const report = {
    checkedAt: new Date().toISOString(),
    wikiHost: WIKI_HOST,
    template: null,
    invokedModule: null,
    doc: null,
    samples: [],
  };

  section(`1. ${TEMPLATE_TITLE} 自体のソースを取得`);
  const templatePage = await fetchWikitext(TEMPLATE_TITLE);
  if (!templatePage) {
    console.log('  → ページが見つかりませんでした。テンプレート名が変わっている可能性があります。');
  } else {
    console.log(`  revid=${templatePage.revid} timestamp=${templatePage.timestamp}`);
    console.log('  --- wikitext ---');
    console.log(templatePage.wikitext);
    report.template = templatePage;

    const moduleTitle = detectInvokedModule(templatePage.wikitext);
    if (moduleTitle) {
      console.log(`\n  → Luaモジュール呼び出しを検出: ${moduleTitle}`);
      const modulePage = await fetchWikitext(moduleTitle);
      if (modulePage) {
        section(`1b. ${moduleTitle} のソース（引数名の最も確実な一次資料）`);
        console.log(modulePage.wikitext);
        report.invokedModule = modulePage;
      } else {
        console.log(`  → ${moduleTitle} が見つかりませんでした。`);
      }
    } else {
      console.log('  → #invoke: は検出されませんでした（Luaモジュールを使わない実装の可能性）。');
    }
  }

  section(`2. ${DOC_TITLE} を取得`);
  const docPage = await fetchWikitext(DOC_TITLE);
  if (!docPage) {
    console.log('  → docページは存在しないようです。');
  } else {
    console.log(`  revid=${docPage.revid} timestamp=${docPage.timestamp}`);
    console.log('  --- wikitext（先頭3000文字）---');
    console.log(docPage.wikitext.slice(0, 3000));
    report.doc = docPage;
  }

  section(`3. ${TEMPLATE_TITLE} の実使用例を ${SAMPLE_PAGE_COUNT} 件取得`);
  const embedded = await fetchEmbeddedIn(TEMPLATE_TITLE, SAMPLE_PAGE_COUNT);
  if (embedded.length === 0) {
    console.log('  → 使用しているページが見つかりませんでした。');
  } else {
    console.log(`  → ${embedded.length}件見つかりました: ${embedded.map((p) => p.title).join(', ')}`);
  }

  const parser = new WikitextParser();
  for (const p of embedded) {
    section(`3-${p.title}: 実際の呼び出し内容`);
    const page = await fetchWikitext(p.title);
    if (!page) {
      console.log('  → 取得できませんでした。');
      continue;
    }
    const parsed = parser.parse(page.wikitext, { templates: [TEMPLATE_TITLE] });
    const calls = parsed.templates.filter((t) => t.name === TEMPLATE_TITLE);
    if (calls.length === 0) {
      console.log('  → WikitextParserではテンプレート呼び出しを検出できませんでした（要目視確認）。');
      console.log('  --- wikitext（先頭1000文字）---');
      console.log(page.wikitext.slice(0, 1000));
    }
    for (const call of calls) {
      console.log('  --- テンプレート呼び出し(原文) ---');
      console.log('  ' + call.original.replace(/\n/g, '\n  '));
      console.log('  --- argsOrdered（出現順・キー・値・絶対位置） ---');
      console.log(JSON.stringify(call.argsOrdered, null, 2));
    }
    report.samples.push({
      title: page.title,
      revid: page.revid,
      calls: calls.map((c) => ({ original: c.original, argsOrdered: c.argsOrdered })),
    });
  }

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  section('完了');
  console.log(`詳細レポートを ${outPath} に保存しました。`);
  console.log('この出力（特に1b.のモジュールソースと3.の実例）をもとに、仕様書8章の');
  console.log('「Category置換 Step4 / Category除去 Step2」の実装方針を確定してください。');
}

module.exports = { parseArgs, detectInvokedModule };

if (require.main === module) {
  main().catch((err) => {
    console.error('スクリプト実行中にエラーが発生しました:', err);
    process.exitCode = 1;
  });
}
