'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { removePageFromHatnotes } = require('../src/worker/hatnoteUnlink');

test('removePageFromHatnotes: 他の引数があれば該当ページの引数だけを除く', () => {
  assert.equal(removePageFromHatnotes('{{See also|削除|残る}}\n本文', '削除').wikitext, '{{See also|残る}}\n本文');
  assert.equal(removePageFromHatnotes('{{混同|残る|削除|別}}', '削除').wikitext, '{{混同|残る|別}}');
});

test('removePageFromHatnotes: 引数が残らなければ呼び出しごと除き、行だけの呼び出しは改行も除く', () => {
  assert.equal(removePageFromHatnotes('{{See also|削除}}\n本文', '削除').wikitext, '本文');
  assert.equal(removePageFromHatnotes('前 {{Main|削除}} 後', '削除').wikitext, '前  後');
});

test('removePageFromHatnotes: 表記ゆれ（先頭小文字・アンダースコア・節指定）も同じページとして扱う', () => {
  const result = removePageFromHatnotes('{{see_also| foo_bar#節 |Baz}}', 'Foo bar');
  assert.equal(result.wikitext, '{{see_also|Baz}}');
  assert.equal(result.count, 1);
});

test('removePageFromHatnotes: 名前付き引数を含む呼び出し・役割の違うハットノート・本文は変更しない', () => {
  for (const text of ['{{See also|削除|l1=表示}}', '{{Otheruses|説明|削除}}', '本文[[削除]]', '{{See also|削除する}}']) {
    const result = removePageFromHatnotes(text, '削除');
    assert.equal(result.wikitext, text);
    assert.equal(result.changed, false);
  }
});

test('removePageFromHatnotes: 解除対象のページ名が本文に無ければ解析せずにそのまま返す', () => {
  const { removePageFromHatnotes: remove } = require('../src/worker/hatnoteUnlink');
  const text = '{{See also|別の記事}} 本文';
  assert.deepEqual(remove(text, '消すページ'), { wikitext: text, changed: false, count: 0 });
  // 下線で書かれていても見つける
  assert.equal(remove('{{See also|Foo_bar}}本文', 'Foo bar').changed, true);
});
