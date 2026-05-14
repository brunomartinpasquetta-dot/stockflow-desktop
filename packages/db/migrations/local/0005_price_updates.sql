CREATE TABLE IF NOT EXISTS price_update_batches (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  articles_affected INTEGER NOT NULL DEFAULT 0,
  applied_at INTEGER NOT NULL,
  rolled_back_at INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS price_update_entries (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES price_update_batches(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id),
  field TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pu_batch ON price_update_entries(batch_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pu_article ON price_update_entries(article_id);
