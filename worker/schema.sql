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

CREATE TRIGGER IF NOT EXISTS prevent_archived_report_recreation
BEFORE INSERT ON reports
WHEN EXISTS (SELECT 1 FROM archived_receipts WHERE id = NEW.id)
BEGIN
  SELECT RAISE(IGNORE);
END;
