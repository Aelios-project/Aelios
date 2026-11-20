CREATE TABLE rolling_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  message_id TEXT NOT NULL,
  rolling_skipped INTEGER NOT NULL DEFAULT 0,
  window_key TEXT,
  claimed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  progress TEXT,
  done_at TEXT,
  error TEXT,
  shadow_window_key TEXT,
  shadow_claimed_at TEXT,
  shadow_attempts INTEGER NOT NULL DEFAULT 0,
  shadow_progress TEXT,
  shadow_done_at TEXT,
  shadow_error TEXT,
  UNIQUE(namespace, message_id)
);

CREATE INDEX idx_rolling_inbox_open
ON rolling_inbox(namespace, done_at, seq);
CREATE INDEX idx_rolling_inbox_claim
ON rolling_inbox(namespace, window_key, done_at);
CREATE INDEX idx_rolling_inbox_shadow_open
ON rolling_inbox(namespace, shadow_done_at, done_at, seq);
CREATE INDEX idx_rolling_inbox_shadow_claim
ON rolling_inbox(namespace, shadow_window_key, shadow_done_at);

CREATE INDEX idx_memory_events_namespace_type_time
ON memory_events(namespace, event_type, created_at);

CREATE TRIGGER rolling_inbox_capture AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'assistant')
BEGIN
  INSERT OR IGNORE INTO rolling_inbox(namespace, message_id)
  VALUES(NEW.namespace, NEW.id);
END;

CREATE TRIGGER rolling_inbox_remove AFTER DELETE ON messages
BEGIN
  DELETE FROM rolling_inbox
  WHERE namespace = OLD.namespace AND message_id = OLD.id;
END;
