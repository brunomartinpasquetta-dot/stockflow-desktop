CREATE TABLE IF NOT EXISTS mp_config (
  id TEXT PRIMARY KEY NOT NULL,
  company_id TEXT REFERENCES companies(id),
  mp_user_id TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  store_id TEXT,
  webhook_url_configured INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mp_pos_devices (
  id TEXT PRIMARY KEY NOT NULL,
  cash_register_id TEXT NOT NULL UNIQUE REFERENCES cash_registers(id),
  external_pos_id TEXT NOT NULL UNIQUE,
  mp_pos_id TEXT NOT NULL,
  qr_url TEXT NOT NULL,
  qr_image_base64 TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mp_orders (
  id TEXT PRIMARY KEY NOT NULL,
  mp_pos_device_id TEXT NOT NULL REFERENCES mp_pos_devices(id),
  sale_id TEXT REFERENCES sales(id),
  external_reference TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  mp_payment_id TEXT UNIQUE,
  mp_merchant_order_id TEXT,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mp_orders_status ON mp_orders(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mp_orders_expires ON mp_orders(expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mp_orders_external_ref ON mp_orders(external_reference);
