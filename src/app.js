'use strict';

const express = require('express');
const session = require('express-session');
const MySQLStoreFactory = require('express-mysql-session');

const config = require('./config');
const { pool } = require('./db');
const { attachUser } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const emergencyRoutes = require('./routes/emergency');
const dashboardRoutes = require('./routes/dashboard');

function createApp() {
  const app = express();

  // ToolforgeのKubernetesバックエンドはリバースプロキシ配下で動くため、
  // secure cookieを正しく判定するためにtrust proxyを設定する。
  app.set('trust proxy', 1);

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
  app.use(express.json());
  app.use(attachUser);

  app.use(authRoutes);
  app.use(emergencyRoutes);
  app.use(dashboardRoutes);

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
