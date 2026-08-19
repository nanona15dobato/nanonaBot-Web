'use strict';

/**
 * 仕様書6章のテンプレート置換5種類を、regexEngine.applyReplacementSteps に渡せる
 * steps配列に変換する。{from}/{to}をパターン文字列へ埋め込む際は正規表現特殊文字を
 * 必ずエスケープする（6章の実装時注記どおり）。
 *
 * 注: ハットノート系正規表現（hatnoteStep）は、原案の正規表現に構文上の不備
 * （先頭の開き括弧の欠落＝不正な正規表現）があったため、開き括弧を補って修正している。
 */

/** 正規表現の特殊文字をエスケープする。 */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** String.replaceの置換文字列側で `$` が特殊文字として解釈されるのを防ぐ。 */
function escapeReplacementDollar(str) {
  return String(str).replace(/\$/g, '$$$$');
}

/**
 * MediaWikiのページタイトル規則（多くのウィキ・多くの名前空間で先頭1文字だけ
 * 大文字小文字を区別しない。2文字目以降は区別する）に合わせた正規表現パターンを作る。
 * 単純に正規表現全体へ 'i' フラグを付けると、無関係な別ページ（例: "MyTemplate" と
 * "mytemplate"）まで誤って一致してしまうため、先頭文字だけを文字クラス化する。
 */
function firstLetterFlexiblePattern(name) {
  const str = String(name);
  if (str.length === 0) return '';
  const first = str[0];
  const rest = escapeRegExp(str.slice(1));
  const upper = first.toUpperCase();
  const lower = first.toLowerCase();
  if (upper === lower) {
    // 数字・記号・大文字小文字の概念が無い文字（多くの日本語文字を含む）はそのまま
    return escapeRegExp(first) + rest;
  }
  return `[${escapeRegExp(upper)}${escapeRegExp(lower)}]${rest}`;
}

/**
 * ハットノート系テンプレート（{{See also|X}}等）内の素の参照を修正する共通ステップ。
 * 6.1/6.2/6.3節で共有される「共通ステップA」。
 */
function hatnoteStep(from, to) {
  const f = firstLetterFlexiblePattern(from);
  const tRep = escapeReplacementDollar(to);
  return {
    pattern:
      '(\\{\\{(?:[Ss]ee(?:[ _]also)?|For[12]?|[Mm]ain|[Oo]theruses(?:list|2)?|' +
      '[Oo]ther[ _](?:people|ships)|混同2?|[Rr]edirect|仮リンク)[^\\}]*\\|\\s*)' +
      f +
      '(\\s*[\\|\\}#])',
    flags: 'g',
    replacement: '$1' + tRep + '$2',
  };
}

/** 6.1 リンク置換（標準） */
function linkRenameSteps(from, to) {
  const f = firstLetterFlexiblePattern(from);
  const t = firstLetterFlexiblePattern(to);
  const tRep = escapeReplacementDollar(to);
  return [
    {
      pattern: `\\[\\[\\s*${f}\\s*(\\]\\]|\\#[^\\]]*\\]\\]|\\|[^\\]]*\\]\\])`,
      flags: 'g',
      replacement: `[[${tRep}$1`,
    },
    {
      pattern: `\\[\\[\\s*${t}\\s*\\|\\s*${t}\\s*\\]\\]`,
      flags: 'g',
      replacement: `[[${tRep}]]`,
    },
    hatnoteStep(from, to),
  ];
}

/** 6.2 リンク置換2（表示保持・リンク先のみ変更） */
function linkRename2Steps(from, to) {
  const f = firstLetterFlexiblePattern(from);
  const t = firstLetterFlexiblePattern(to);
  const fRep = escapeReplacementDollar(from);
  const tRep = escapeReplacementDollar(to);
  return [
    {
      pattern: `\\[\\[\\s*${f}\\s*\\]\\]`,
      flags: 'g',
      replacement: `[[${tRep}|${fRep}]]`,
    },
    {
      pattern: `\\[\\[\\s*${f}\\s*(\\]\\]|\\#[^\\]]*\\]\\]|\\|[^\\]]*\\]\\])`,
      flags: 'g',
      replacement: `[[${tRep}$1`,
    },
    {
      pattern: `\\[\\[\\s*${t}\\s*\\|\\s*${t}\\s*\\]\\]`,
      flags: 'g',
      replacement: `[[${tRep}]]`,
    },
    hatnoteStep(from, to),
  ];
}

/**
 * 6.3 Category置換（標準）。from/toはCategory:プレフィックスを除いた素の名前。
 * Step4（Template:リダイレクトの所属カテゴリの更新）は8章の方針により
 * 自動編集ステップとしては生成しない（warningSourceで検出・警告のみ行う）。
 */
function categoryRenameSteps(from, to) {
  const f = firstLetterFlexiblePattern(from);
  const t = firstLetterFlexiblePattern(to);
  const tRep = escapeReplacementDollar(to);
  const nsAlt = '(?:Category|category|カテゴリ)';
  return [
    {
      pattern: `\\[\\[\\s*${nsAlt}:\\s*${f}\\s*(\\|[^\\]]*)?\\]\\]`,
      flags: 'g',
      replacement: `[[Category:${tRep}$1]]`,
    },
    {
      // 重複した[[Category:to]]タグを1つに整理する（3つ以上の重複にも対応するためloopUntilStable）
      pattern:
        `(\\[\\[\\s*${nsAlt}:\\s*${t}\\s*(?:\\|[^\\]]*)?\\]\\])([\\s\\S]*?)\\n?` +
        `\\[\\[\\s*${nsAlt}:\\s*${t}\\s*(?:\\|[^\\]]*)?\\]\\]`,
      flags: '',
      replacement: '$1$2',
      loopUntilStable: true,
    },
    hatnoteStep(from, to),
  ];
}

/**
 * 6.4 Category除去（標準）。fromはCategory:プレフィックスを除いた素の名前。
 * Step2（Template:リダイレクトの所属カテゴリの更新）は8章の方針により自動編集しない。
 */
function categoryRemoveSteps(from) {
  const f = firstLetterFlexiblePattern(from);
  return [
    {
      pattern: `\\n?\\[\\[\\s*(?:Category|category|カテゴリ):\\s*${f}\\s*(\\|[^\\]]*)?\\]\\]`,
      flags: 'g',
      replacement: '',
    },
  ];
}

/**
 * 6.5 テンプレート置換（単純名称変更のみ）。from/toはTemplate:プレフィックスを除いた素の名前。
 */
function templateRenameSteps(from, to) {
  const f = firstLetterFlexiblePattern(from);
  const tRep = escapeReplacementDollar(to);
  return [
    {
      pattern: `(\\{\\{\\s*)${f}\\s*([\\|\\}])`,
      flags: 'g',
      replacement: `$1${tRep}$2`,
    },
  ];
}

/**
 * リンク解除（フェーズ6。BOTREQの DELETE_PAGE 相当）。
 * [[from]] → from、[[from|表示名]] → 表示名、[[from#アンカー]] → from のように、
 * 通常のwikilinkを地の文に変換する。ハットノート系テンプレート内の参照解除は対象外
 * （フェーズ1範囲外。必要な場合はcustom置換で個別対応する）。
 */
function unlinkPageSteps(from) {
  const f = firstLetterFlexiblePattern(from);
  return [
    {
      // パイプ付き（表示名あり）: [[from|表示名]] → 表示名
      pattern: `\\[\\[\\s*${f}\\s*(?:\\#[^\\]|]*)?\\|([^\\]]*)\\]\\]`,
      flags: 'g',
      replacement: '$1',
    },
    {
      // パイプなし: [[from]] / [[from#アンカー]] → from
      pattern: `\\[\\[\\s*${f}\\s*(?:\\#[^\\]]*)?\\]\\]`,
      flags: 'g',
      replacement: escapeReplacementDollar(from),
    },
  ];
}

/**
 * テンプレートのsubst化（フェーズ6。BOTREQの Template:X → subst: 相当）。
 * {{from ...}} → {{subst:from ...}} に変換する。既に {{subst:from ...}} のものは
 * 二重にsubst:が付かないよう除外する。
 */
function templateSubstSteps(from) {
  const f = firstLetterFlexiblePattern(from);
  return [
    {
      // 'subst:'/'safesubst:' の判定は小文字表記のみを見る（テンプレート名側は
      // firstLetterFlexiblePatternで先頭文字のみ大文字小文字を許容し、名前全体を
      // 大文字小文字無視にしてしまわないようにするため、全体には'i'フラグを付けない）
      pattern: `(\\{\\{\\s*)(?!subst:|safesubst:)${f}\\s*([\\|\\}])`,
      flags: 'g',
      replacement: `$1subst:${escapeReplacementDollar(from)}$2`,
    },
  ];
}

/**
 * templateType名から対応するステップ生成関数を呼び出す。
 * @param {string} templateType
 * @param {{from?: string, to?: string}} params
 * @returns {Array} steps配列
 */
function buildStepsForTemplateType(templateType, { from, to }) {
  switch (templateType) {
    case 'linkRename':
      return linkRenameSteps(from, to);
    case 'linkRename2':
      return linkRename2Steps(from, to);
    case 'categoryRename':
      return categoryRenameSteps(from, to);
    case 'categoryRemove':
      return categoryRemoveSteps(from);
    case 'templateRename':
      return templateRenameSteps(from, to);
    case 'unlinkPage':
      return unlinkPageSteps(from);
    case 'templateSubst':
      return templateSubstSteps(from);
    default:
      throw new Error(`buildStepsForTemplateType: 未知のtemplateType "${templateType}"`);
  }
}

const TEMPLATE_TYPES_REQUIRING_TO = ['linkRename', 'linkRename2', 'categoryRename', 'templateRename'];
const KNOWN_PRESET_TEMPLATE_TYPES = [
  'linkRename',
  'linkRename2',
  'categoryRename',
  'categoryRemove',
  'templateRename',
  'unlinkPage',
  'templateSubst',
];

module.exports = {
  escapeRegExp,
  escapeReplacementDollar,
  hatnoteStep,
  linkRenameSteps,
  linkRename2Steps,
  categoryRenameSteps,
  categoryRemoveSteps,
  templateRenameSteps,
  unlinkPageSteps,
  templateSubstSteps,
  buildStepsForTemplateType,
  TEMPLATE_TYPES_REQUIRING_TO,
  KNOWN_PRESET_TEMPLATE_TYPES,
};
