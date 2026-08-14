'use strict';

const { isKnownAccount } = require('../bot/accountNames');

/**
 * タスク作成時のconfig_jsonを検証する（純粋関数）。
 * フェーズ2時点では `templateType: "custom"` かつ
 * `targetSource.type: "manualList"` の組み合わせのみを許可する
 * （仕様書13章フェーズ2のスコープ）。他のtemplateType/targetSourceは
 * フェーズ4以降で対応する。
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTaskConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['configはオブジェクトである必要があります'] };
  }

  if (!Array.isArray(config.replacements) || config.replacements.length === 0) {
    errors.push('replacementsは1件以上の配列である必要があります');
  } else {
    config.replacements.forEach((rule, i) => {
      if (rule.templateType !== 'custom') {
        errors.push(`replacements[${i}]: フェーズ2時点では templateType "custom" のみ対応しています`);
        return;
      }
      if (!Array.isArray(rule.steps) || rule.steps.length === 0) {
        errors.push(`replacements[${i}]: stepsは1件以上の配列である必要があります`);
      } else {
        rule.steps.forEach((step, si) => {
          if (typeof step.pattern !== 'string' || step.pattern.length === 0) {
            errors.push(`replacements[${i}].steps[${si}]: patternは空でない文字列である必要があります`);
          } else {
            try {
              // eslint-disable-next-line no-new
              new RegExp(step.pattern, step.flags || 'g');
            } catch (e) {
              errors.push(`replacements[${i}].steps[${si}]: patternが不正な正規表現です (${e.message})`);
            }
          }
          if (typeof step.replacement !== 'string') {
            errors.push(`replacements[${i}].steps[${si}]: replacementは文字列である必要があります`);
          }
        });
      }
      if (!rule.targetSource || rule.targetSource.type !== 'manualList') {
        errors.push(`replacements[${i}]: フェーズ2時点では targetSource.type "manualList" のみ対応しています`);
      } else if (!Array.isArray(rule.targetSource.titles) || rule.targetSource.titles.length === 0) {
        errors.push(`replacements[${i}].targetSource.titles: 1件以上のページ名配列が必要です`);
      }
    });
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

  return { valid: errors.length === 0, errors };
}

module.exports = { validateTaskConfig };
