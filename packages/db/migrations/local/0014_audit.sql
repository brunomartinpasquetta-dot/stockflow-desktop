-- AUDITORÍA: registro de todas las operaciones de escritura del sistema.
-- Se llena automáticamente desde la capa IPC (ver electron/ipc/audit.ts).
CREATE TABLE `audit_log` (
  `id` text PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL,
  `user_id` text,
  `username` text NOT NULL,
  `channel` text NOT NULL,
  `area` text NOT NULL,
  `description` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_created` ON `audit_log` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_audit_user` ON `audit_log` (`user_id`);
