CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_tasks (
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'browser',
  title TEXT NOT NULL,
  content_format TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_html TEXT NOT NULL,
  login_session_id TEXT,
  login_session_expires_at TEXT,
  login_qr_mime TEXT,
  login_qr_png_base64 TEXT,
  publish_url TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES publish_tasks(task_id)
);

CREATE TABLE IF NOT EXISTS publish_audit_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  trigger TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES publish_tasks(task_id)
);

CREATE INDEX IF NOT EXISTS idx_publish_tasks_status ON publish_tasks(status);
CREATE INDEX IF NOT EXISTS idx_publish_events_task_id ON publish_events(task_id);
CREATE INDEX IF NOT EXISTS idx_publish_audit_logs_task_id ON publish_audit_logs(task_id);
