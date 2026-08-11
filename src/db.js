'use strict';

const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./config');
const { readReplicaCnf } = require('./db/replicaCnf');

/**
 * DB接続設定を組み立てる。
 * Toolforge本番: $HOME/replica.my.cnf の認証情報 + tools.db.svc.wikimedia.cloud を使う。
 * ローカル開発: replica.my.cnfが無ければ .env の DB_* を使う。
 */
function buildPoolConfig() {
  const cnfPath = process.env.REPLICA_MY_CNF_PATH || path.join(os.homedir(), 'replica.my.cnf');

  try {
    const creds = readReplicaCnf(cnfPath);
    if (creds.user && creds.password !== undefined) {
      return {
        host: 'tools.db.svc.wikimedia.cloud',
        port: 3306,
        user: creds.user,
        password: creds.password,
        database: `${creds.user}__${config.db.toolsdbSuffix}`,
        charset: 'utf8mb4_general_ci',
        supportBigNumbers: true,
      };
    }
  } catch (e) {
    // replica.my.cnfが存在しない環境（ローカル開発等）はフォールバックへ
  }

  if (config.db.localHost) {
    return {
      host: config.db.localHost,
      port: config.db.localPort,
      user: config.db.localUser,
      password: config.db.localPassword,
      database: config.db.localDatabase,
      charset: 'utf8mb4_general_ci',
      supportBigNumbers: true,
    };
  }

  throw new Error(
    'DB接続情報を取得できませんでした。Toolforge上ならreplica.my.cnfの有無を、' +
    'ローカル開発なら.envのDB_*設定を確認してください。'
  );
}

const pool = mysql.createPool({
  ...buildPoolConfig(),
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = { pool, buildPoolConfig };
