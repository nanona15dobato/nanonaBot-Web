'use strict';

const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const { getNotifySettings, saveNotifySettings } = require('../services/settings');
const { notifyDetailed, ALL_EVENTS } = require('../services/notify');

/**
 * 通知設定の入力チェック（純粋関数）。null は「環境変数の値に戻す」。
 * @returns {{values: object, errors: string[]}}
 */
function validateNotifySettings(body) {
  const errors = [];
  const values = {};
  const input = body || {};

  if ('webhookUrl' in input) {
    const v = input.webhookUrl === null ? null : String(input.webhookUrl).trim();
    if (v && !/^https:\/\/[^\s]+$/i.test(v)) errors.push('Webhook URLは https:// で始まるURLにしてください。');
    values.webhookUrl = v;
  }
  if ('mailTo' in input) {
    const v = input.mailTo === null ? null : String(input.mailTo).trim();
    const bad = (v || '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .filter((a) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a));
    if (bad.length > 0) errors.push(`メールの宛先の形式が不正です: ${bad.join(', ')}`);
    values.mailTo = v;
  }
  if ('mailFrom' in input) {
    const v = input.mailFrom === null ? null : String(input.mailFrom).trim();
    // Toolforgeのメールサーバーは「ツール名.任意の文字列@toolforge.org」形式の送信者だけを受け付ける（Help:Toolforge/Email）
    if (v && !/[^\s@<>]+\.[^\s@<>]+@toolforge\.org>?$/i.test(v)) {
      errors.push('メールの送信元は「ツール名.任意の文字列@toolforge.org」形式にしてください（例: "表示名" <nanonabot01.weberror@toolforge.org>）。');
    }
    values.mailFrom = v;
  }
  if ('events' in input) {
    if (input.events === null) {
      values.events = null;
    } else if (!Array.isArray(input.events) || input.events.some((e) => !ALL_EVENTS.includes(e))) {
      errors.push('通知する種類の指定が不正です。');
    } else {
      // 全部選んだときは空（＝すべて）として保存する
      values.events = input.events.length === ALL_EVENTS.length ? '' : input.events.join(',');
    }
  }
  return { values, errors };
}

function toResponse(settings) {
  return {
    webhookUrl: settings.webhookUrl,
    mailTo: settings.mailTo,
    mailFrom: settings.mailFrom,
    events: settings.events ? settings.events.split(',').map((e) => e.trim()).filter(Boolean) : ALL_EVENTS,
    sources: settings.sources,
    allEvents: ALL_EVENTS,
  };
}

router.get('/api/settings/notify', requireRole('owner'), async (req, res, next) => {
  try {
    res.json(toResponse(await getNotifySettings({ fresh: true })));
  } catch (err) {
    next(err);
  }
});

router.put('/api/settings/notify', requireRole('owner'), async (req, res, next) => {
  try {
    const { values, errors } = validateNotifySettings(req.body);
    if (errors.length > 0) return res.status(400).json({ error: 'invalid_settings', errors });
    await saveNotifySettings(values, req.session.username);
    console.warn(`[settings] 通知設定が ${req.session.username} により変更されました`);
    res.json(toResponse(await getNotifySettings({ fresh: true })));
  } catch (err) {
    next(err);
  }
});

// 現在の設定でテスト通知を送る（通知する種類の絞り込みに関係なく送る）
router.post('/api/settings/notify/test', requireRole('owner'), async (req, res, next) => {
  try {
    const result = await notifyDetailed({
      event: 'test',
      title: `テスト通知（${req.session.username} が設定画面から送信）`,
      message: 'この通知が届いていれば、通知先の設定は正しく動いています。',
      path: '/settings',
      settings: await getNotifySettings({ fresh: true }),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.validateNotifySettings = validateNotifySettings;
