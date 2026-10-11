'use strict';

/**
 * Bot作業依頼の作業記録（利用者:nanonaBot/依頼/YYYY年）と依頼の節を扱う純粋関数（フェーズ13）。
 * 利用者スクリプト（userscripts/botreq.js）と同じ書式を作る。既存の記録をそのまま「完了」で更新できるよう、
 * 書式を変えるときは両方を合わせること。
 */

/** 作業記録の <!--sec 節ID|編集回数--> では、節IDの「-」をこの文字（U+FFFD）に置き換える（コメント内の「--」を避けるため）。 */
const SEC_ID_SEP = '�';
const HEAD_COUNT_RE = /\{\{\.\.\/head([^}]*\|\s*件数\s*=\s*)(\d*)/;
/** 依頼の節（署名つきコメントがある見出し）の DiscussionTools の ID は、時刻で終わる。 */
const REQUEST_THREAD_ID_RE = /-\d{14}$/;

const JST = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Asia/Tokyo',
});

function jstParts(date) {
  return Object.fromEntries(JST.formatToParts(new Date(date)).map((p) => [p.type, p.value]));
}

/** 例: 2026年1月3日 (土) 15:27 (JST) */
function formatJst(date) {
  const p = jstParts(date);
  return `${p.year}年${p.month}月${p.day}日 (${p.weekday}) ${p.hour}:${p.minute} (JST)`;
}

function jstYear(date) {
  return jstParts(date).year;
}

/** 投稿記録の offset 形式（YYYYMMDDHHMMSS、UTC） */
function contribsOffset(date) {
  return new Date(date).toISOString().replace(/[-:TZ]/g, '').split('.')[0];
}

function encodeSecId(threadId) {
  return String(threadId).replace(/-/g, SEC_ID_SEP);
}

function secMarker(threadId) {
  return `<!--sec ${encodeSecId(threadId)}|`;
}

function logTitleFor(logPrefix, timestamp) {
  return `${logPrefix}${jstYear(timestamp)}年`;
}

function newLogPage(year, operator) {
  return `{{../head\n|y=${year}\n|運用者=${operator}\n|件数=0\n}}`;
}

/** {{../head|件数=N}} を N+1 にする。 */
function incrementHeadCount(content) {
  const match = content.match(HEAD_COUNT_RE);
  if (!match) return null;
  const num = Number(match[2] || 0) + 1;
  return { num, content: content.replace(HEAD_COUNT_RE, (all, mid) => `{{../head${mid}${num}`) };
}

/**
 * 着手時に追加する作業記録の節。
 * @param {object} p
 */
function buildStartSection({ num, name, threadId, editCount, logTitle, discussion, requester, requesterName, requestedAt, now }) {
  const botSummary = `Bot:[[${logTitle}#botreq-n-${num}|作業依頼]] - ${name}`;
  const text = [
    `== <span class="anchor" id="botreq-n-${num}"></span>${name} ==`,
    `<!--sec ${encodeSecId(threadId)}|${editCount}-->`,
    `* 要約欄 - <code><nowiki>${botSummary}</nowiki></code>`,
    `* 依頼 - [[特別:GoToComment/${threadId}|§ ${name}]]`,
    `* 議論場所 - ${discussion || ''}`,
    `* 依頼者 - [[User:${requester}|${requesterName || requester}]] さん`,
    `* 依頼時刻 - ${formatJst(requestedAt)}`,
    `* 着手(準備)時刻 - ${formatJst(now)}`,
    '* 終了時刻 - ',
    '* 作業 - ',
  ].join('\n');
  return { text, botSummary };
}

/** 作業記録の節の範囲（marker を含む見出しの行から、次の見出しの手前まで）。 */
function logSectionBounds(content, markerAt) {
  const markerLine = content.lastIndexOf('\n', markerAt - 1) + 1;
  const prevLine = markerLine > 0 ? content.lastIndexOf('\n', markerLine - 2) + 1 : 0;
  const start = markerLine > 0 && content.charAt(prevLine) === '=' ? prevLine : markerLine;
  const next = /\n=/g;
  next.lastIndex = markerAt;
  const m = next.exec(content);
  return { start, end: m ? m.index + 1 : content.length };
}

/**
 * 作業記録の中から、その依頼の節を探す。
 * @returns {null | {start, end, core, tail, startCount, finished}}
 */
function findLogSection(content, threadId) {
  const marker = secMarker(threadId);
  const at = content.indexOf(marker);
  if (at === -1) return null;
  const countMatch = content.slice(at + marker.length).match(/^\s*(\d+)\s*-->/);
  const { start, end } = logSectionBounds(content, at);
  const section = content.slice(start, end);
  const core = section.replace(/\s+$/, '');
  return {
    start,
    end,
    core,
    tail: section.slice(core.length),
    startCount: countMatch ? Number(countMatch[1]) : null,
    finished: /^\* 着手時刻 - /m.test(core),
  };
}

/** {{利用者の投稿記録リンク}} を、新しい順に perLink 件ずつ並べる。contribs は新しい順。 */
function contributionLinks(user, contribs, perLink = 5000) {
  const links = [];
  for (let i = 0; i < contribs.length; i += perLink) {
    const chunk = contribs.slice(i, i + perLink);
    const offset = contribsOffset(Date.parse(chunk[0].timestamp) + 1000);
    links.push(`{{利用者の投稿記録リンク|${user}|${chunk.length}|${offset}|text=${chunk.length}編集}}`);
  }
  return links.join(',') + (links.length > 1 ? `の計${contribs.length}編集` : '');
}

/** 完了時の作業記録の節（着手・終了時刻と作業内容を書き込む）。 */
function buildCompleteSection(core, { oldest, newest, work }) {
  return core
    .replace(/^\* 着手(?:\(準備\))?時刻 - .*$/m, () => `* 着手時刻 - ${formatJst(oldest)}`)
    .replace(/^\* 終了時刻 -.*$/m, () => `* 終了時刻 - ${formatJst(newest)}`)
    .replace(/^\* 作業 -.*$/m, () => `* 作業 - ${work}`);
}

function completeComment({ requester, work }) {
  return `{{at|${requester}}}:{{BOTREQ|完了}} Botにて${work}行いました。が0項目のため、完了とします。問題等なければ{{tl|確認}}の貼付をお願いします。--~~~~`;
}

/** 依頼の節の見出しの直後に {{解決済み}} を入れる。 */
function insertResolved(sectionText) {
  const lines = sectionText.split('\n');
  lines.splice(1, 0, '{{解決済み|~~~~}}');
  return lines.join('\n');
}

/**
 * 依頼の節のウィキテキストから状態を読む。
 * {{解決済み}} があれば解決済み、無ければ最後の {{BOTREQ|…}} で判断する。
 * @returns {{status: 'open'|'started'|'completed'|'resolved'|'other', label: string|null}}
 */
function detectStatus(sectionText) {
  const text = String(sectionText || '');
  if (/\{\{\s*解決済み/.test(text)) return { status: 'resolved', label: '解決済み' };
  const all = [...text.matchAll(/\{\{\s*BOTREQ\s*\|\s*([^|}]+?)\s*[|}]/gi)];
  if (!all.length) return { status: 'open', label: null };
  const last = all[all.length - 1][1];
  if (/完了|済/.test(last)) return { status: 'completed', label: last };
  if (/着手/.test(last)) return { status: 'started', label: last };
  return { status: 'other', label: last };
}

/** HTMLの断片から見出しの文字列を取り出す（DiscussionTools の見出しと action=parse の節を突き合わせるため）。 */
function plainText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function findThreadItem(items, id) {
  for (const item of items || []) {
    if (item.id === id) return item;
    const found = findThreadItem(item.replies, id);
    if (found) return found;
  }
  return null;
}

/** 依頼の節の見出し（DiscussionTools）を文書順に集める（小見出しも含む）。 */
function collectRequestHeadings(items, out = []) {
  for (const item of items || []) {
    if (item.type === 'heading' && REQUEST_THREAD_ID_RE.test(item.id || '')) out.push(item);
    collectRequestHeadings(item.replies, out);
  }
  return out;
}

/** 見出しの下のコメントのうち最も古いもの（＝依頼）。小見出しの中は、その小見出しの依頼なので含めない。 */
function firstComment(heading) {
  const comments = [];
  (function walk(items) {
    for (const item of items || []) {
      if (item.type === 'heading') continue;
      if (item.type === 'comment') comments.push(item);
      walk(item.replies);
    }
  })(heading && heading.replies);
  comments.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return comments[0] || null;
}

// 議論場所の候補にしない名前空間（署名の利用者ページ・特別・ファイル・テンプレート）
const SKIP_PREFIX_RE = /^(利用者|利用者‐会話|User|User talk|User_talk|特別|Special|ファイル|File|画像|Image|Template|テンプレート|MediaWiki|Help|ヘルプ)\s*:/i;
const CATEGORY_PREFIX_RE = /^(Category|カテゴリ)\s*:/i;
// 議論の場になる名前空間（ノート・Wikipedia・プロジェクトなど）
const DISCUSSION_PREFIX_RE = /^([^:]*ノート|[^:]*‐会話|Talk|Wikipedia|WP|プロジェクト|Portal)\s*:/i;

/**
 * 依頼の節のウィキテキストから、議論場所の候補（ウィキテキストのリンク）を集める。
 * ノートやプロジェクト関連のページを先に並べる。
 * @param {string} sectionText
 * @param {{requestPage?: string}} [options]
 * @returns {Array<{label: string, wikitext: string}>}
 */
function discussionLinks(sectionText, options = {}) {
  const text = String(sectionText || '').replace(/<!--[\s\S]*?-->/g, '');
  const seen = new Set();
  const links = [];
  const push = (link) => {
    if (seen.has(link.wikitext)) return;
    seen.add(link.wikitext);
    links.push({ ...link, order: links.length });
  };
  for (const m of text.matchAll(/\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g)) {
    let target = m[1].trim().replace(/_/g, ' ');
    const label = (m[2] || '').trim();
    target = target.replace(/^:/, '');
    if (!target || SKIP_PREFIX_RE.test(target)) continue;
    const page = target.split('#')[0].trim();
    if (!page || (options.requestPage && page === options.requestPage)) continue;
    const link = (CATEGORY_PREFIX_RE.test(target) ? ':' : '') + target;
    push({
      label: label && label !== target ? `${target}（${label}）` : target,
      wikitext: label && label !== target ? `[[${link}|${label}]]` : `[[${link}]]`,
      priority: DISCUSSION_PREFIX_RE.test(target) ? 0 : 1,
    });
  }
  for (const m of text.matchAll(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/g)) {
    push({ label: m[1], wikitext: m[2] ? `[${m[1]} ${m[2].trim()}]` : `[${m[1]}]`, priority: 2 });
  }
  return links
    .sort((a, b) => a.priority - b.priority || a.order - b.order)
    .map(({ label, wikitext }) => ({ label, wikitext }));
}

/**
 * byteoffset の位置でウィキテキストを切れるようにする。名前に反して jawiki の action=parse は
 * 文字（コードポイント）単位の位置を返すため、まず文字単位で切り、各節が見出し（=）から始まらなければバイト単位で切る。
 */
function offsetSlicer(wikitext, offsets) {
  const chars = Array.from(wikitext);
  const byChars = { length: chars.length, slice: (a, b) => chars.slice(a, b).join('') };
  if (offsets.every((o) => chars[o] === '=')) return byChars;
  const buf = Buffer.from(wikitext, 'utf8');
  const byBytes = { length: buf.length, slice: (a, b) => buf.slice(a, b).toString('utf8') };
  if (offsets.every((o) => buf[o] === 0x3d)) return byBytes;
  throw new Error('節の位置とウィキテキストが一致しません。読み込み直してください。');
}

/**
 * action=parse の節一覧（このページ自身の節だけ）とウィキテキストから、各節の本文を切り出す。
 * text は見出しの階層が同じか上の次の節まで（小節を含む。節の編集の範囲と同じ）、ownText は次の節まで。
 * @param {string} wikitext
 * @param {Array<{index: string, level: string|number, line: string, byteoffset: number|null, fromtitle: string|false}>} sections
 * @param {string} pageTitle
 */
function sliceSections(wikitext, sections, pageTitle) {
  const own = sections.filter((s) => s.fromtitle === pageTitle && /^\d+$/.test(String(s.index)) && Number.isInteger(s.byteoffset));
  const text = offsetSlicer(wikitext, own.map((s) => s.byteoffset));
  return own.map((s, i) => {
    const level = Number(s.level);
    let end = text.length;
    for (let j = i + 1; j < own.length; j++) {
      if (Number(own[j].level) <= level) {
        end = own[j].byteoffset;
        break;
      }
    }
    // ownText: 小節を含まない、その見出しだけの本文（状態の判定に使う。親の見出しの状態が小見出しの依頼に引きずられないように）
    const ownEnd = i + 1 < own.length ? own[i + 1].byteoffset : text.length;
    return {
      index: String(s.index),
      level,
      name: plainText(s.line),
      text: text.slice(s.byteoffset, end),
      ownText: text.slice(s.byteoffset, ownEnd),
    };
  });
}

/**
 * DiscussionTools の依頼の見出しと、節（sliceSections の結果）を文書順に突き合わせる。
 * @returns {Array<{heading: object, section: object|null}>}
 */
function matchHeadingsToSections(headings, sections) {
  let cursor = 0;
  return headings.map((heading) => {
    const name = plainText(heading.html);
    for (let i = cursor; i < sections.length; i++) {
      if (sections[i].name === name) {
        cursor = i + 1;
        return { heading, name, section: sections[i] };
      }
    }
    return { heading, name, section: null };
  });
}

module.exports = {
  SEC_ID_SEP,
  REQUEST_THREAD_ID_RE,
  formatJst,
  jstYear,
  contribsOffset,
  encodeSecId,
  secMarker,
  logTitleFor,
  newLogPage,
  incrementHeadCount,
  buildStartSection,
  logSectionBounds,
  findLogSection,
  contributionLinks,
  buildCompleteSection,
  completeComment,
  insertResolved,
  detectStatus,
  plainText,
  findThreadItem,
  collectRequestHeadings,
  firstComment,
  discussionLinks,
  sliceSections,
  matchHeadingsToSections,
};
