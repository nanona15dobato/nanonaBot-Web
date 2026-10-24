'use strict';

const { roleAllowed } = require('../permissions');
const { resolveRole } = require('../services/authorization');

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
 * セッションの古いroleを信用せず、ルート処理の前に現在の権限を再確認する。
 * app.jsで全API・ページより先に実行する。認証の開始・完了・ログアウトは
 * グループAPIの障害時にも利用できるよう、古い権限を公開せずに通す。
 */
async function attachUser(req, res, next) {
  res.locals.username = null;
  res.locals.role = null;
  if (!req.session) return next();
  if (!req.session.username) {
    delete req.session.role;
    return next();
  }
  if (
    (req.method === 'GET' && ['/oauth/login', '/oauth/callback'].includes(req.path)) ||
    (req.method === 'POST' && req.path === '/oauth/logout')
  ) return next();

  try {
    req.session.role = await resolveRole(req.session.username);
    res.locals.username = req.session.username;
    res.locals.role = req.session.role;
    return next();
  } catch (err) {
    // 外部APIの失敗で以前の権限を使い続けない。復旧後の要求で再確認できる。
    req.session.role = 'denied';
    const message = '現在の利用権限を確認できません。しばらくしてから再度お試しください。';
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ error: 'authorization_unavailable', message });
    }
    return res.status(503).send(message);
  }
}

module.exports = { requireRole, attachUser };
