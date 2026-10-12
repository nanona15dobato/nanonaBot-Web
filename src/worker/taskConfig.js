'use strict';

const { isKnownAccount } = require('../bot/accountNames');
const { KNOWN_PRESET_TEMPLATE_TYPES, TEMPLATE_TYPES_REQUIRING_TO } = require('./templatePresets');

const VALID_TARGET_SOURCE_TYPES = ['manualList', 'category', 'backlinks', 'embeddedin', 'regexSearch'];

function isValidNamespaces(namespaces) {
  if (namespaces === undefined || namespaces === null) return true;
  return Array.isArray(namespaces) && namespaces.every((n) => Number.isInteger(n) && n >= 0);
}

function validateStep(step, prefix, errors) {
  if (!step || typeof step !== 'object') {
    errors.push(`${prefix}: オブジェクトである必要があります`);
    return;
  }
  if (typeof step.pattern !== 'string' || step.pattern.length === 0) {
    errors.push(`${prefix}: patternは空でない文字列である必要があります`);
  } else {
    try {
      // eslint-disable-next-line no-new
      new RegExp(step.pattern, step.flags || 'g');
    } catch (e) {
      errors.push(`${prefix}: patternが不正な正規表現です (${e.message})`);
    }
  }
  if (typeof step.replacement !== 'string') {
    errors.push(`${prefix}: replacementは文字列である必要があります`);
  }
}

function validateTargetSource(targetSource, prefix, errors) {
  if (!targetSource || !VALID_TARGET_SOURCE_TYPES.includes(targetSource.type)) {
    errors.push(`${prefix}: targetSource.typeは ${VALID_TARGET_SOURCE_TYPES.join('/')} のいずれかである必要があります`);
    return;
  }
  if (!isValidNamespaces(targetSource.namespaces)) {
    errors.push(`${prefix}.targetSource.namespaces: 0以上の整数の配列、またはnull/省略である必要があります`);
  }
  switch (targetSource.type) {
    case 'manualList':
      if (!Array.isArray(targetSource.titles) || targetSource.titles.length === 0) {
        errors.push(`${prefix}.targetSource.titles: 1件以上のページ名配列が必要です`);
      }
      break;
    case 'category':
      if (typeof targetSource.category !== 'string' || !targetSource.category.trim()) {
        errors.push(`${prefix}.targetSource.category: 空でない文字列である必要があります`);
      }
      break;
    case 'backlinks':
    case 'embeddedin':
      if (typeof targetSource.page !== 'string' || !targetSource.page.trim()) {
        errors.push(`${prefix}.targetSource.page: 空でない文字列である必要があります`);
      }
      break;
    case 'regexSearch':
      if (typeof targetSource.query !== 'string' || !targetSource.query.trim()) {
        errors.push(`${prefix}.targetSource.query: 空でない文字列である必要があります`);
      }
      break;
    default:
      break;
  }
}

function validateRule(rule, i, errors) {
  const prefix = `replacements[${i}]`;
  if (!rule || typeof rule !== 'object') {
    errors.push(`${prefix}: オブジェクトである必要があります`);
    return;
  }
  const type = rule.templateType;

  if (type === 'revertEdits') {
    // 一括取り消し（フェーズ12）。POST /api/tasks/:id/revert がサーバー側で作る
    if (!Number.isInteger(rule.revertOfTaskId) || rule.revertOfTaskId <= 0) {
      errors.push(`${prefix}.revertOfTaskId: 取り消すタスクのIDが必要です`);
    }
    const validTargets =
      Array.isArray(rule.targets) &&
      rule.targets.length > 0 &&
      rule.targets.every(
        (t) =>
          t &&
          typeof t.title === 'string' &&
          Number.isInteger(t.revid) &&
          Number.isInteger(t.baseRevid) &&
          (t.edits === undefined || (Array.isArray(t.edits) && t.edits.every((e) => Number.isInteger(e.revid) && Number.isInteger(e.baseRevid))))
      );
    if (!validTargets) errors.push(`${prefix}.targets: 取り消す編集（title・revid・baseRevid）が1件以上必要です`);
    if (rule.useUndo !== undefined && typeof rule.useUndo !== 'boolean') errors.push(`${prefix}.useUndo: 真偽値である必要があります`);
    return;
  }

  if (type === 'custom') {
    if (!Array.isArray(rule.steps) || rule.steps.length === 0) {
      errors.push(`${prefix}: stepsは1件以上の配列である必要があります`);
    } else {
      rule.steps.forEach((step, si) => validateStep(step, `${prefix}.steps[${si}]`, errors));
    }
    validateTargetSource(rule.targetSource, prefix, errors);
    return;
  }

  if (!KNOWN_PRESET_TEMPLATE_TYPES.includes(type)) {
    errors.push(
      `${prefix}: templateTypeは "custom" または ${KNOWN_PRESET_TEMPLATE_TYPES.join('/')} のいずれかである必要があります`
    );
    return;
  }

  // テンプレート系（linkRename/linkRename2/categoryRename/categoryRemove/templateRename）は
  // from（必須）/ to（種別による）/ namespaces（任意）のみを受け取り、
  // 実際のsteps・targetSourceはtaskRunner側でtemplatePresets/targetResolversを使って自動生成する。
  if (typeof rule.from !== 'string' || !rule.from.trim()) {
    errors.push(`${prefix}.from: 空でない文字列である必要があります`);
  }
  if (TEMPLATE_TYPES_REQUIRING_TO.includes(type)) {
    if (typeof rule.to !== 'string' || !rule.to.trim()) {
      errors.push(`${prefix}.to: templateType "${type}" ではtoが必須です`);
    }
  }
  if (!isValidNamespaces(rule.namespaces)) {
    errors.push(`${prefix}.namespaces: 0以上の整数の配列、またはnull/省略である必要があります`);
  }
  if (type === 'urlRename') {
    for (const key of ['from', 'to']) {
      if (typeof rule[key] === 'string' && rule[key].trim() && !/^https?:\/\/[^\s/?#]+/i.test(rule[key].trim())) {
        errors.push(`${prefix}.${key}: http:// または https:// で始まるURLである必要があります`);
      }
    }
  }
  for (const key of ['fromAnchor', 'toAnchor', 'fromLabel', 'toLabel']) {
    if (rule[key] !== undefined && rule[key] !== null && typeof rule[key] !== 'string') {
      errors.push(`${prefix}.${key}: 文字列またはnullである必要があります`);
    }
  }
  if (rule.bothSchemes !== undefined && typeof rule.bothSchemes !== 'boolean') {
    errors.push(`${prefix}.bothSchemes: 真偽値である必要があります`);
  }
  if (rule.fixCategoryLinks !== undefined && typeof rule.fixCategoryLinks !== 'boolean') {
    errors.push(`${prefix}.fixCategoryLinks: 真偽値である必要があります`);
  }
  if (rule.searchNarrowing !== undefined) {
    if (typeof rule.searchNarrowing !== 'boolean') {
      errors.push(`${prefix}.searchNarrowing: 真偽値である必要があります`);
    } else if (rule.searchNarrowing && !['linkRename', 'linkRename2', 'linkRenameExact'].includes(type)) {
      errors.push(`${prefix}.searchNarrowing: 検索での絞り込みはリンク置換だけで使えます`);
    }
  }
}

/**
 * タスク作成時のconfig_jsonを検証する（純粋関数）。
 * フェーズ4で、5種類のテンプレート（templatePresets.js）と4種類の自動取得
 * （targetResolvers.js: category/backlinks/embeddedin/regexSearch）に対応した。
 * "custom" は引き続き steps + targetSource（5種いずれか）を直接指定する形式。
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTaskConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['configはオブジェクトである必要があります'] };
  }

  if (!Array.isArray(config.replacements) || config.replacements.length === 0) {
    errors.push('replacementsは1件以上の配列である必要があります');
  } else {
    config.replacements.forEach((rule, i) => validateRule(rule, i, errors));
  }

  if (!config.account || !isKnownAccount(config.account)) {
    errors.push('accountはNanona15dobato/NanonaBot/NanonaBot3のいずれかである必要があります');
  }

  if (!config.editSettings || typeof config.editSettings !== 'object') {
    errors.push('editSettingsは必須です');
  } else {
    if (typeof config.editSettings.editSummary !== 'string' || !config.editSettings.editSummary.trim()) {
      errors.push('editSettings.editSummaryは空でない文字列である必要があります');
    }
    const { linkUpdateMethod } = config.editSettings;
    if (linkUpdateMethod !== undefined && !['nullEdit', 'purge'].includes(linkUpdateMethod)) {
      errors.push('editSettings.linkUpdateMethodは"nullEdit"または"purge"である必要があります');
    }
    const interval = config.editSettings.editIntervalSeconds;
    if (typeof interval !== 'number' || interval < 5) {
      errors.push('editSettings.editIntervalSecondsは5以上の数値である必要があります（仕様書12章の最小間隔）');
    }
  }

  if (!config.reviewSettings || !['auto', 'manual'].includes(config.reviewSettings.mode)) {
    errors.push('reviewSettings.modeは"auto"または"manual"である必要があります');
  } else if (config.reviewSettings.mode === 'auto') {
    if (typeof config.reviewSettings.autoWaitSeconds !== 'number' || config.reviewSettings.autoWaitSeconds < 0) {
      errors.push('reviewSettings.autoWaitSecondsは0以上の数値である必要があります');
    }
  } else if (config.reviewSettings.mode === 'manual') {
    if (
      typeof config.reviewSettings.manualTimeoutHours !== 'number' ||
      config.reviewSettings.manualTimeoutHours <= 0
    ) {
      errors.push('reviewSettings.manualTimeoutHoursは正の数値である必要があります');
    }
  }

  if (!['pause', 'skipAndContinue'].includes(config.onFailure)) {
    errors.push('onFailureは"pause"または"skipAndContinue"である必要があります');
  }

  // Bot作業依頼への紐づけ（任意。フェーズ13）: Bot作業依頼の画面にこのタスクを表示し、完了時の内訳の確認に使う
  if (config.botreq !== undefined && config.botreq !== null) {
    const b = config.botreq;
    if (typeof b !== 'object' || typeof b.threadId !== 'string' || !/^h-.+-\d{14}$/.test(b.threadId)) {
      errors.push('botreq.threadId: 依頼の節のID（h-…-YYYYMMDDhhmmss）である必要があります');
    } else if (b.name !== undefined && typeof b.name !== 'string') {
      errors.push('botreq.name: 文字列である必要があります');
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateTaskConfig, VALID_TARGET_SOURCE_TYPES };

