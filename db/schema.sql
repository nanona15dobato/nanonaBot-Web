-- =====================================================================
-- NanonaBot Tool - DBスキーマ（フェーズ1）
--
-- 実行方法（Toolforge上、ToolsDBに接続した状態で）:
--   1. あらかじめデータベースを作成しておく:
--        CREATE DATABASE IF NOT EXISTS `<credentialUser>__nanona_bot`
--          CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
--      （<credentialUser> は $HOME/replica.my.cnf の user の値。
--        .env の TOOLSDB_DATABASE_SUFFIX を変えた場合は末尾も合わせる）
--   2. そのDBに対して本ファイルを流し込む:
--        mysql --defaults-file=$HOME/replica.my.cnf \
--          -h tools.db.svc.wikimedia.cloud \
--          <credentialUser>__nanona_bot < db/schema.sql
--
-- 仕様書 4章（データモデル）に対応。
-- sessionsテーブルは express-mysql-session が自動生成するため、
-- ここには含めない（既定テーブル名 "sessions"）。
-- =====================================================================

-- 現在システム全体が緊急停止中かどうかを保持する単一行テーブル
CREATE TABLE IF NOT EXISTS system_status (
  id                   TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  emergency_stopped    BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_stopped_by VARCHAR(255) NULL,
  emergency_stopped_at DATETIME NULL,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                          ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- id=1固定の行を1つだけ用意する（無ければ緊急停止していない扱い）
INSERT INTO system_status (id, emergency_stopped)
  VALUES (1, FALSE)
  ON DUPLICATE KEY UPDATE id = id;

-- タスク（1キュー1タスク。仕様書4章）
CREATE TABLE IF NOT EXISTS tasks (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_by         VARCHAR(255) NOT NULL,
  account            ENUM('Nanona15dobato', 'NanonaBot', 'NanonaBot3') NOT NULL,
  mode               ENUM('auto', 'manual') NOT NULL,
  status             ENUM(
                        'queued', 'running', 'paused', 'completed',
                        'completed_with_failures', 'failed', 'cancelled',
                        'expired', 'emergency_stopped'
                      ) NOT NULL DEFAULT 'queued',
  config_json        JSON NOT NULL,
  target_titles_json JSON NULL,
  progress_current   INT UNSIGNED NOT NULL DEFAULT 0,
  progress_total     INT UNSIGNED NOT NULL DEFAULT 0,
  review_timeout_at  DATETIME NULL,
  retry_of_task_id   INT UNSIGNED NULL,
  stage_count        TINYINT UNSIGNED NOT NULL DEFAULT 1,
  current_stage      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_status (status),
  KEY idx_retry_of_task_id (retry_of_task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ページ単位の作業データ（9章の1ページ先読みパイプライン用。作業用・定期削除対象）
CREATE TABLE IF NOT EXISTS task_pages (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id               INT UNSIGNED NOT NULL,
  stage                 TINYINT UNSIGNED NOT NULL DEFAULT 1,
  order_index           INT UNSIGNED NOT NULL,
  page_title            VARCHAR(512) NOT NULL,
  namespace             INT NOT NULL,
  matched_rule_indices  JSON NULL,
  status                ENUM(
                          'pending', 'preparing', 'prepared', 'awaiting_review',
                          'approved', 'rejected', 'editing', 'edited',
                          'failed', 'skipped'
                        ) NOT NULL DEFAULT 'pending',
  base_revid            BIGINT UNSIGNED NULL,
  base_timestamp        DATETIME NULL,
  original_wikitext     MEDIUMTEXT NULL,
  new_wikitext          MEDIUMTEXT NULL,
  error_message         TEXT NULL,
  prepared_at           DATETIME NULL,
  reviewed_at           DATETIME NULL,
  edited_at             DATETIME NULL,
  KEY idx_task_stage_order (task_id, stage, order_index),
  KEY idx_task_status (task_id, status),
  CONSTRAINT fk_task_pages_task
    FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 恒久監査ログ（本文を含まない。task_pagesとは独立してその場で書き込む。9.4節）
CREATE TABLE IF NOT EXISTS edit_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id       INT UNSIGNED NULL,
  stage         TINYINT UNSIGNED NOT NULL DEFAULT 1,
  page_title    VARCHAR(512) NOT NULL,
  namespace     INT NOT NULL,
  account       VARCHAR(255) NOT NULL,
  status        ENUM('edited', 'failed') NOT NULL,
  revid         BIGINT UNSIGNED NULL,
  base_revid    BIGINT UNSIGNED NULL,
  edit_summary  VARCHAR(1000) NULL,
  error_message TEXT NULL,
  edited_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_task_id (task_id),
  KEY idx_page_title (page_title(191)),
  KEY idx_edited_at (edited_at),
  CONSTRAINT fk_edit_log_task
    FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
