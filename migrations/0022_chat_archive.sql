-- Read by search_chat only. Raw memory inputs and their retention stay separate.
CREATE TABLE chat_archive (
  rowid INTEGER PRIMARY KEY,
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  speaker TEXT,
  created_at TEXT NOT NULL,
  position INTEGER NOT NULL,
  stored_at TEXT NOT NULL,
  UNIQUE (namespace, id)
);

CREATE INDEX idx_chat_archive_conversation ON chat_archive(namespace, conversation_id, position);
CREATE INDEX idx_chat_archive_retention ON chat_archive(stored_at);

-- The original text lives only in chat_archive. FTS stores the bigram postings.
CREATE VIRTUAL TABLE chat_archive_fts USING fts5(space, body, content='', contentless_delete=1);

CREATE TRIGGER chat_archive_delete_fts AFTER DELETE ON chat_archive BEGIN
  DELETE FROM chat_archive_fts WHERE rowid = old.rowid;
END;
