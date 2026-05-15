CREATE TABLE IF NOT EXISTS cash_general (
  id TEXT PRIMARY KEY,
  current_balance TEXT NOT NULL DEFAULT '0',
  last_update INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cash_general_movements (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('income','expense','transfer_from_daily')),
  amount TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  reference_id TEXT,
  balance_after TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cgm_date ON cash_general_movements(created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cgm_type ON cash_general_movements(type);
--> statement-breakpoint
INSERT OR IGNORE INTO cash_general (id, current_balance, last_update, created_at)
VALUES ('singleton', '0', unixepoch('now') * 1000, unixepoch('now') * 1000);
