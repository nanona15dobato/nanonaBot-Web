'use strict';

const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const { pool } = require('../db');
const { isKnownAccount } = require('../bot/accountNames');
const { parseJsonColumn, toJsonColumn } = require('../dbJson');

const DEFAULT_EDIT_SETTINGS = { botFlag: true, minorEdit: true, editSummary: 'Bot: 編集', editIntervalSeconds: 10 };
const DEFAULT_REVIEW_SETTINGS = { mode: 'auto', autoWaitSeconds: 300, manualTimeoutHours: 72 };

function validateDefaults(body) {
  const edit = body && body.editSettings;
  const review = body && body.reviewSettings;
  const errors = [];
  if (!edit || typeof edit !== 'object' || typeof edit.botFlag !== 'boolean' || typeof edit.minorEdit !== 'boolean') {
    errors.push('editSettingsの形式が不正です');
  } else if (
    typeof edit.editSummary !== 'string' ||
    !edit.editSummary.trim() ||
    edit.editSummary.length > 1000 ||
    !Number.isFinite(edit.editIntervalSeconds) ||
    edit.editIntervalSeconds < 5
  ) {
    errors.push('editSettings.editSummaryまたはeditIntervalSecondsが不正です');
  }
  if (
    !review ||
    !['auto', 'manual'].includes(review.mode) ||
    (review.mode === 'auto' && (!Number.isFinite(review.autoWaitSeconds) || review.autoWaitSeconds < 0)) ||
    (review.mode === 'manual' && (!Number.isFinite(review.manualTimeoutHours) || review.manualTimeoutHours <= 0))
  ) {
    errors.push('reviewSettingsの形式が不正です');
  }
  return errors;
}

router.get('/api/bot-accounts/defaults', requireRole('owner'), async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT account, edit_settings_json, review_settings_json FROM bot_account_defaults');
    const stored = new Map(rows.map((row) => [row.account, row]));
    res.json(['Nanona15dobato', 'NanonaBot', 'NanonaBot3'].map((account) => {
      const row = stored.get(account);
      return {
        account,
        editSettings: row ? parseJsonColumn(row.edit_settings_json, DEFAULT_EDIT_SETTINGS) : { ...DEFAULT_EDIT_SETTINGS },
        reviewSettings: row ? parseJsonColumn(row.review_settings_json, DEFAULT_REVIEW_SETTINGS) : { ...DEFAULT_REVIEW_SETTINGS },
      };
    }));
  } catch (err) {
    next(err);
  }
});

router.put('/api/bot-accounts/:account/defaults', requireRole('owner'), async (req, res, next) => {
  try {
    const { account } = req.params;
    if (!isKnownAccount(account)) return res.status(400).json({ error: 'invalid_account' });
    const errors = validateDefaults(req.body);
    if (errors.length > 0) return res.status(400).json({ error: 'invalid_defaults', errors });
    await pool.query(
      `INSERT INTO bot_account_defaults
       (account, edit_settings_json, review_settings_json, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE edit_settings_json = VALUES(edit_settings_json),
         review_settings_json = VALUES(review_settings_json), updated_by = VALUES(updated_by)`,
      [account, toJsonColumn(req.body.editSettings), toJsonColumn(req.body.reviewSettings), req.session.username]
    );
    res.json({ ok: true, account, editSettings: req.body.editSettings, reviewSettings: req.body.reviewSettings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
