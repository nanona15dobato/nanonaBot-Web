'use strict';

const WikitextParser = require('../../lib/WikitextParser');

const DEFAULT_MAX_LOOP = 50;
// 置換の結果の上限（文字数）。MediaWiki のページの上限（2MB）を超える本文はどのみち保存できない。
// 空の文字列に一致する正規表現（a* など）が全ての位置に挿入して本文が膨れ続け、ワーカーがメモリ不足で落ちるのを防ぐ
const MAX_RESULT_LENGTH = 2200000;

class ReplacementTooLargeError extends Error {}

function checkSize(text, original, step) {
  if (text.length > MAX_RESULT_LENGTH && text.length > original.length) {
    throw new ReplacementTooLargeError(
      `置換の結果が大きくなりすぎたため中止しました（${text.length}文字。パターン: ${String(step.pattern).slice(0, 80)}）。` +
        '空の文字列に一致する正規表現（a* など）で、全ての位置に文字を挿入していないか確認してください'
    );
  }
}

/**
 * 1つの置換ステップ定義。
 * @typedef {object} ReplacementStep
 * @property {string} pattern - 正規表現（文字列。newRegExp(pattern, flags)で使う）
 * @property {string} [flags] - 既定 "g"
 * @property {string} replacement - String.replaceの第2引数（$1等が使える）
 * @property {boolean} [loopUntilStable] - trueの場合、変化が無くなるかMAX_LOOPに達するまで
 *   同じステップを繰り返し適用する（仕様書6.3節「Category置換Step2」のような重複整理用）
 */

/**
 * wikitextに対して、置換ステップの配列を順番に適用する（仕様書6章）。
 * 適用前に WikitextParser.protectRegions で <nowiki>/<pre>/コメント等を保護し、
 * 適用後に復元する。
 *
 * @param {string} wikitext
 * @param {ReplacementStep[]} steps
 * @param {object} [options]
 * @param {object} [options.protectOptions] - WikitextParser.protectRegionsへ渡すoptions
 * @returns {string} 置換後のwikitext
 */
function applyReplacementSteps(wikitext, steps, options = {}) {
  const { masked, restore } = WikitextParser.protectRegions(wikitext, options.protectOptions);
  let text = masked;

  for (const step of steps) {
    const re = new RegExp(step.pattern, step.flags || 'g');
    if (step.loopUntilStable) {
      let prev;
      let iterations = 0;
      do {
        prev = text;
        text = text.replace(re, step.replacement);
        checkSize(text, masked, step);
        iterations++;
      } while (text !== prev && iterations < DEFAULT_MAX_LOOP);
    } else {
      text = text.replace(re, step.replacement);
      checkSize(text, masked, step);
    }
  }

  return restore(text);
}

module.exports = { applyReplacementSteps, ReplacementTooLargeError, MAX_RESULT_LENGTH };
