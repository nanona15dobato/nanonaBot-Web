-- PWA端末通知。既存テーブル・データは変更しない。
-- 対象DBを選択してから実行する。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  endpoint      TEXT NOT NULL,
  p256dh        VARCHAR(87) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  auth          VARCHAR(22) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id    VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  username      VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  events_json   JSON NOT NULL,
  expires_at    DATETIME NOT NULL,
  vapid_key     CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_push_session (session_id),
  KEY idx_push_user (username),
  KEY idx_push_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
