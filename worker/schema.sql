CREATE TABLE IF NOT EXISTS reports (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 4000),
  image BLOB,
  image_type TEXT,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archived_receipts (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  archived_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jira_deliveries (
  report_key TEXT PRIMARY KEY, summary TEXT NOT NULL, description TEXT NOT NULL,
  source TEXT NOT NULL, source_id TEXT NOT NULL, created_at TEXT NOT NULL,
  state TEXT NOT NULL, delivery_token TEXT NOT NULL, evidence_token TEXT NOT NULL,
  issue_key TEXT, attempted_at TEXT, claimed_at TEXT, delivered_at TEXT,
  last_http_status INTEGER
);
CREATE TABLE IF NOT EXISTS jira_report_sources (
  source TEXT NOT NULL, source_id TEXT NOT NULL, report_key TEXT NOT NULL,
  created_at TEXT NOT NULL, metadata TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
);

CREATE TRIGGER IF NOT EXISTS prevent_archived_report_recreation
BEFORE INSERT ON reports
WHEN EXISTS (SELECT 1 FROM archived_receipts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(IGNORE);
END;
