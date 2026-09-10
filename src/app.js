'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');

const config = require('./config');
const { pool } = require('./db');
const { attachUser } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const emergencyRoutes = require('./routes/emergency');
const pagesRoutes = require('./routes/pages');
const tasksRoutes = require('./routes/tasks');
const botreqRoutes = require('./routes/botreq');
const botAccountsRoutes = require('./routes/botAccounts');

function createApp() {
  const app = express();

  // ToolforgeのKubernetesバックエンドはリバースプロキシ配下で動くため、
  // secure cookieを正しく判定するためにtrust proxyを設定する。
  app.set('trust proxy', 1);

  // OOUI本体（jQuery/OOjs/OOUI）・自作のCSS/JSは認証不要の静的ファイルとして配信する
  // （公式の「標準的な組み込み方法」に準拠。npmjs.com/package/oojs-ui 参照）。
  // session/body-parserより前に置き、静的ファイル配信のたびにDBへセッション照会が
  // 走らないようにする。
  app.use('/vendor/jquery', express.static(path.join(__dirname, '..', 'node_modules', 'jquery', 'dist')));
  app.use('/vendor/oojs', express.static(path.join(__dirname, '..', 'node_modules', 'oojs', 'dist')));
  app.use('/vendor/oojs-ui', express.static(path.join(__dirname, '..', 'node_modules', 'oojs-ui', 'dist')));
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));

  const MySQLStore = MySQLStoreFactory(session);
  const sessionStore = new MySQLStore({}, pool);

  app.use(
    session({
      key: 'nanona_bot_sid',
      secret: config.session.secret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7日
      },
    })
  );

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '2mb' })); // task作成時のreplacements/manualList titles等がある程度大きくても受け付けられるように

  app.use(attachUser);

  app.use(authRoutes);
  app.use(emergencyRoutes);
  app.use(tasksRoutes);
  app.use(botreqRoutes);
  app.use(botAccountsRoutes);
  app.use(pagesRoutes);

  app.use((req, res) => {
    res.status(404).send('Not Found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('サーバーエラーが発生しました。');
  });

  return app;
}

module.exports = createApp;
