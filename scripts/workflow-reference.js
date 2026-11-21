'use strict';
// Compile documentation examples with the same pure transforms as the worker. No DB/network.
const assert = require('node:assert/strict');
const { buildStepsForTemplateType, categoryTextSteps } = require('../src/worker/templatePresets');
const { applyReplacementSteps } = require('../src/worker/regexEngine');
const { renameCategoryInTemplate, removeCategoryFromTemplate } = require('../src/worker/redirectCategoryTemplate');
const { removePageFromHatnotes } = require('../src/worker/hatnoteUnlink');
function compile(reference) {
  return reference.map(rule => {
    const examples = rule.examples.map(example => {
      const p = example.params;
      let steps = rule.id === 'custom' ? p.steps : buildStepsForTemplateType(rule.id, p);
      if (rule.id === 'categoryRename' && p.fixCategoryLinks) steps = [...steps, ...categoryTextSteps(p.from, p.to)];
      let actual = applyReplacementSteps(example.before, steps);
      if (rule.id === 'categoryRename') actual = renameCategoryInTemplate(actual, p.from, p.to).wikitext;
      if (rule.id === 'categoryRemove') actual = removeCategoryFromTemplate(actual, p.from).wikitext;
      if (rule.id === 'unlinkPage') actual = removePageFromHatnotes(actual, p.from).wikitext;
      assert.equal(actual, example.after, `Documentation example drift: ${rule.id}`);
      return { ...example, steps };
    });
    return { ...rule, examples };
  });
}
module.exports = { compile };
if (require.main === module) {
  let input = '';process.stdin.setEncoding('utf8');process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => process.stdout.write(JSON.stringify(compile(JSON.parse(input)))));
}
