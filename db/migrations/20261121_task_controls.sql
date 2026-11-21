-- Apply to the selected ToolsDB before deploying both Web and worker.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS pause_requested TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worker_active TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS control_revision INT UNSIGNED NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS task_target_overrides (
  task_id INT UNSIGNED NOT NULL,
  page_title VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  namespace INT NOT NULL,
  excluded TINYINT(1) NOT NULL DEFAULT 0,
  added TINYINT(1) NOT NULL DEFAULT 0,
  updated_by VARCHAR(255) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, page_title),
  CONSTRAINT fk_target_overrides_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
