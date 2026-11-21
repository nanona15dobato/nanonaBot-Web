'use strict';
const express = require('express');
const { requireRole } = require('../middleware/auth');
const { pool } = require('../db');
const controls = require('../services/taskControls');
const search = require('../services/targetSearch');
const router = express.Router();
router.param('id', (req, res, next, value) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return res.status(400).json({ error: 'invalid_task_id' });
  next();
});
function route(fn) {
  return async (req, res, next) => {
    try { await fn(req, res); }
    catch (error) {
      if (error instanceof controls.TaskControlError) return res.status(error.status).json({ error: error.code, message: error.message });
      next(error);
    }
  };
}
router.post('/api/tasks/:id/pause', requireRole('owner'), route(async (req,res) => res.json(await controls.pause(Number(req.params.id),req.session.username))));
router.put('/api/tasks/:id/config', requireRole('owner'), route(async (req,res) => res.json(await controls.updateConfig(Number(req.params.id),req.session.username,req.body?.config,req.body?.revision))));
router.post('/api/tasks/:id/targets', requireRole('owner'), route(async (req,res) => res.json(await controls.updateTargets(Number(req.params.id),req.session.username,req.body || {}))));
router.get('/api/tasks/:id/targets', requireRole('owner'), route(async (req,res) => {
  const [rows] = await pool.query('SELECT page_title, namespace, added, excluded FROM task_target_overrides WHERE task_id = ? AND (added=1 OR excluded=1) ORDER BY page_title', [req.params.id]);
  res.json(rows);
}));
router.get('/api/wiki/namespaces', requireRole('owner'), route(async (req,res) => res.json(await search.namespaces())));
router.post('/api/wiki/page-search', requireRole('owner'), route(async (req,res) => res.json(await search.search({ ...(req.body || {}), method:'prefix' }))));
router.post('/api/tasks/:id/target-search', requireRole('owner'), route(async (req,res) => res.json(await search.forTask(Number(req.params.id),req.body || {}))));
module.exports = router;
