'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const presets = require('../src/worker/templatePresets');
const { applyReplacementSteps } = require('../src/worker/regexEngine');

test('escapeRegExp: 正規表現特殊文字をエスケープする', () => {
  assert.equal(presets.escapeRegExp('A.B*C'), 'A\\.B\\*C');
  assert.equal(presets.escapeRegExp('曖昧さ回避（1）'), '曖昧さ回避（1）'); // 全角括弧はエスケープ不要
  assert.equal(presets.escapeRegExp('C++'), 'C\\+\\+');
});

test('escapeReplacementDollar: $を$$にエスケープする', () => {
  assert.equal(presets.escapeReplacementDollar('100$'), '100$$');
  assert.equal('X'.replace(/X/, presets.escapeReplacementDollar('$1literal')), '$1literal');
});

// ---- リンク置換（標準） ----

test('linkRenameSteps: 裸リンク・アンカー・パイプ付きリンクを一括変換する', () => {
  const steps = presets.linkRenameSteps('プタリン・ジャヤ・スタジアム', 'ペタリン・ジャヤ・スタジアム');
  const text = '[[プタリン・ジャヤ・スタジアム]]と[[プタリン・ジャヤ・スタジアム#歴史]]と[[プタリン・ジャヤ・スタジアム|表示名]]';
  const result = applyReplacementSteps(text, steps);
  assert.equal(
    result,
    '[[ペタリン・ジャヤ・スタジアム]]と[[ペタリン・ジャヤ・スタジアム#歴史]]と[[ペタリン・ジャヤ・スタジアム|表示名]]'
  );
});

test('linkRenameSteps: Step2で冗長パイプ[[to|to]]を整理する', () => {
  const steps = presets.linkRenameSteps('A', 'B');
  // Step1適用後に [[A|A]] -> [[B|A]] となるケースは想定外だが、
  // 既存の [[B|B]] のような冗長表記は整理される
  const result = applyReplacementSteps('[[B|B]]', steps);
  assert.equal(result, '[[B]]');
});

test('linkRenameSteps: ハットノートテンプレート内の参照を修正する（構文エラーにならないことの確認を兼ねる）', () => {
  const steps = presets.linkRenameSteps('プタリン・ジャヤ・スタジアム', 'ペタリン・ジャヤ・スタジアム');
  const text = '{{See also|プタリン・ジャヤ・スタジアム}}\n{{Main|プタリン・ジャヤ・スタジアム#節}}\n{{仮リンク|プタリン・ジャヤ・スタジアム|en|Petaling Jaya Stadium}}';
  const result = applyReplacementSteps(text, steps);
  assert.equal(
    result,
    '{{See also|ペタリン・ジャヤ・スタジアム}}\n{{Main|ペタリン・ジャヤ・スタジアム#節}}\n{{仮リンク|ペタリン・ジャヤ・スタジアム|en|Petaling Jaya Stadium}}'
  );
});

test('linkRenameSteps: <nowiki>内は変更しない', () => {
  const steps = presets.linkRenameSteps('A', 'B');
  const result = applyReplacementSteps('本文[[A]] <nowiki>[[A]]</nowiki>', steps);
  assert.equal(result, '本文[[B]] <nowiki>[[A]]</nowiki>');
});

// ---- リンク置換2（表示保持） ----

test('linkRename2Steps: 裸リンクは表示名を保持したままリンク先だけ変える', () => {
  const steps = presets.linkRename2Steps('プタリン', 'ペタリン・ジャヤ（スタジアム）');
  const result = applyReplacementSteps('[[プタリン]]', steps);
  assert.equal(result, '[[ペタリン・ジャヤ（スタジアム）|プタリン]]');
});

test('linkRename2Steps: 既にパイプ付き・アンカー付きのリンクは表示名を保持しない（Step2のとおりリンク先だけ書き換え）', () => {
  const steps = presets.linkRename2Steps('プタリン', 'ペタリン');
  const result = applyReplacementSteps('[[プタリン|独自の表示名]]と[[プタリン#節]]', steps);
  assert.equal(result, '[[ペタリン|独自の表示名]]と[[ペタリン#節]]');
});

// ---- Category置換 ----

test('categoryRenameSteps: [[Category:from]]を[[Category:to]]に変換する（ソートキー保持）', () => {
  const steps = presets.categoryRenameSteps('旧カテゴリ', '新カテゴリ');
  const result = applyReplacementSteps('[[Category:旧カテゴリ|そーときー]]', steps);
  assert.equal(result, '[[Category:新カテゴリ|そーときー]]');
});

test('categoryRenameSteps: Step1適用後に生じた重複タグを1つに整理する（3つ以上でも対応）', () => {
  const steps = presets.categoryRenameSteps('A', 'B');
  const text = '[[Category:A]]\n本文1\n[[Category:B]]\n本文2\n[[Category:A]]';
  const result = applyReplacementSteps(text, steps);
  const count = (result.match(/\[\[Category:B\]\]/g) || []).length;
  assert.equal(count, 1, '重複したCategory:Bタグは1つに整理されるべき');
});

test('categoryRenameSteps: カテゴリ名前空間の別名（category/カテゴリ）にも対応する', () => {
  const steps = presets.categoryRenameSteps('A', 'B');
  assert.equal(applyReplacementSteps('[[category:A]]', steps), '[[Category:B]]');
  assert.equal(applyReplacementSteps('[[カテゴリ:A]]', steps), '[[Category:B]]');
});

// ---- Category除去 ----

test('categoryRemoveSteps: カテゴリタグを改行ごと削除する', () => {
  const steps = presets.categoryRemoveSteps('除去対象');
  const result = applyReplacementSteps('本文\n[[Category:除去対象]]\n続き', steps);
  assert.equal(result, '本文\n続き');
});

test('categoryRemoveSteps: 対象カテゴリ以外は残す', () => {
  const steps = presets.categoryRemoveSteps('A');
  const result = applyReplacementSteps('[[Category:A]]\n[[Category:B]]', steps);
  assert.equal(result, '\n[[Category:B]]');
});

// ---- テンプレート置換 ----

test('templateRenameSteps: テンプレート呼び出しの名前だけを変更する（引数は保持）', () => {
  const steps = presets.templateRenameSteps('旧テンプレ', '新テンプレ');
  const result = applyReplacementSteps('{{旧テンプレ|引数1|引数2=値}}', steps);
  assert.equal(result, '{{新テンプレ|引数1|引数2=値}}');
});

test('templateRenameSteps: 引数なし呼び出し（{{旧テンプレ}}）でも末尾の}}が失われない（原案の$1二重バグの回帰確認）', () => {
  const steps = presets.templateRenameSteps('旧', '新');
  const result = applyReplacementSteps('{{旧}}', steps);
  assert.equal(result, '{{新}}');
});

// ---- buildStepsForTemplateType ----

test('buildStepsForTemplateType: 各templateTypeに対応するステップを生成する', () => {
  assert.equal(presets.buildStepsForTemplateType('linkRename', { from: 'A', to: 'B' }).length, 3);
  assert.equal(presets.buildStepsForTemplateType('linkRename2', { from: 'A', to: 'B' }).length, 4);
  assert.equal(presets.buildStepsForTemplateType('categoryRename', { from: 'A', to: 'B' }).length, 3);
  assert.equal(presets.buildStepsForTemplateType('categoryRemove', { from: 'A' }).length, 1);
  assert.equal(presets.buildStepsForTemplateType('templateRename', { from: 'A', to: 'B' }).length, 1);
});

test('buildStepsForTemplateType: 未知のtemplateTypeは例外を投げる', () => {
  assert.throws(() => presets.buildStepsForTemplateType('unknown', {}), /未知のtemplateType/);
});

// ---- ページ名に正規表現特殊文字が含まれるケース（実運用での事故防止） ----

test('linkRenameSteps: ページ名に正規表現特殊文字が含まれても安全に扱える', () => {
  const steps = presets.linkRenameSteps('C++ (プログラミング言語)', 'C++（プログラミング言語）');
  const result = applyReplacementSteps('[[C++ (プログラミング言語)]]', steps);
  assert.equal(result, '[[C++（プログラミング言語）]]');
});

test('templateRenameSteps: 置換先に$記号が含まれても文字どおり置換される', () => {
  const steps = presets.templateRenameSteps('価格', '$価格');
  const result = applyReplacementSteps('{{価格|100}}', steps);
  assert.equal(result, '{{$価格|100}}');
});

// ---- リンク解除（unlinkPage、フェーズ6: BOTREQのDELETE_PAGE相当） ----

test('unlinkPageSteps: 裸リンク・アンカー・パイプ付きリンクを地の文に変換する', () => {
  const steps = presets.unlinkPageSteps('プタリン');
  const text = '[[プタリン]]と[[プタリン|表示名]]と[[プタリン#節]]';
  assert.equal(applyReplacementSteps(text, steps), 'プタリンと表示名とプタリン');
});

test('unlinkPageSteps: 対象外のリンクは変更しない', () => {
  const steps = presets.unlinkPageSteps('プタリン');
  assert.equal(applyReplacementSteps('[[別のページ]]', steps), '[[別のページ]]');
});

// ---- テンプレートのsubst化（templateSubst、フェーズ6: BOTREQのTemplate:X→subst:相当） ----

test('templateSubstSteps: {{X}}を{{subst:X}}に変換する', () => {
  const steps = presets.templateSubstSteps('旧テンプレ');
  assert.equal(applyReplacementSteps('{{旧テンプレ|a=1}}', steps), '{{subst:旧テンプレ|a=1}}');
});

test('templateSubstSteps: 既にsubst:/safesubst:済みのものは二重にしない', () => {
  const steps = presets.templateSubstSteps('旧テンプレ');
  assert.equal(applyReplacementSteps('{{subst:旧テンプレ}}', steps), '{{subst:旧テンプレ}}');
  assert.equal(applyReplacementSteps('{{safesubst:旧テンプレ}}', steps), '{{safesubst:旧テンプレ}}');
});

test('templateSubstSteps: 無関係なテンプレートは変更しない', () => {
  const steps = presets.templateSubstSteps('旧テンプレ');
  assert.equal(applyReplacementSteps('{{別テンプレ}}', steps), '{{別テンプレ}}');
});

// ---- firstLetterFlexiblePattern（MediaWikiの先頭1文字大文字小文字非依存規則） ----

test('templateSubstSteps: 先頭1文字だけ大文字小文字を許容する（MediaWikiのタイトル規則）', () => {
  const steps = presets.templateSubstSteps('MyTemplate');
  assert.equal(applyReplacementSteps('{{myTemplate}}', steps), '{{subst:MyTemplate}}');
});

test('templateSubstSteps: 2文字目以降の大文字小文字違いは別ページとして扱い変更しない（gi誤爆の回帰確認）', () => {
  const steps = presets.templateSubstSteps('MyTemplate');
  // "mytemplate" は2文字目以降(ytemplate)がMyTemplateの(yTemplate)と大文字小文字不一致のため対象外
  assert.equal(applyReplacementSteps('{{mytemplate}}', steps), '{{mytemplate}}');
});

test('linkRenameSteps: 先頭1文字だけ大文字小文字を許容する', () => {
  const steps = presets.linkRenameSteps('Example', 'Sample');
  assert.equal(applyReplacementSteps('[[example]]', steps), '[[Sample]]');
});
