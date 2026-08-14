'use strict';

const WikitextParser = require('../../lib/WikitextParser');

const DEFAULT_MAX_LOOP = 50;

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
        iterations++;
      } while (text !== prev && iterations < DEFAULT_MAX_LOOP);
    } else {
      text = text.replace(re, step.replacement);
    }
  }

  return restore(text);
}

module.exports = { applyReplacementSteps };
