-- One current handoff per namespace. Empty content is a versioned tombstone.
CREATE TABLE IF NOT EXISTS current_handoffs (
  namespace TEXT PRIMARY KEY,
  content TEXT,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_resident_at INTEGER NOT NULL DEFAULT 0,
  last_resident_id TEXT NOT NULL DEFAULT ''
);
