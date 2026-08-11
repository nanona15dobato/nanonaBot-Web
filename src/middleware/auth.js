'use strict';

const { roleAllowed } = require('../permissions');

/**
 * 指定した役割のいずれかでなければ403を返すミドルウェアを生成する。
 * 例: router.post('/api/emergency-stop', requireRole('owner', 'admin_emergency_only'), handler)
 * @param {...string} allowedRoles
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.session && req.session.role;
    if (!roleAllowed(role, allowedRoles)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'この操作を行う権限がありません。',
      });
    }
    next();
  };
}

/**
 * ログイン済みならres.localsにユーザー情報をセットする（テンプレート/レスポンス生成用）。
 */
function attachUser(req, res, next) {
  res.locals.username = (req.session && req.session.username) || null;
  res.locals.role = (req.session && req.session.role) || null;
  next();
}

module.exports = { requireRole, attachUser };
