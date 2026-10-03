-- FACTURAS DE COMPRA POR TELÉFONO (ver docs/PLAN_FACTURAS_TELEFONO.md).
--
-- Sólo AGREGA dos tablas: quien no activa la opción no nota nada.
--
-- `article_supplier_codes`: el código con que CADA proveedor llama a un
-- artículo. Se guarda cuando el usuario vincula un renglón de una factura
-- escaneada, y hace que la próxima factura de ese proveedor salga vinculada
-- sola. Un código es de un solo artículo por proveedor (único); un artículo
-- puede tener varios códigos. Si se borra el artículo o el proveedor, el
-- vínculo no significa nada: se va con ellos (CASCADE), así no traba el borrado.
CREATE TABLE IF NOT EXISTS `article_supplier_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`code` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_article_supplier_codes_supplier_code` ON `article_supplier_codes` (`supplier_id`,`code`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_article_supplier_codes_article` ON `article_supplier_codes` (`article_id`);--> statement-breakpoint
-- `scanned_invoices`: una factura fotografiada desde el teléfono. NO es una
-- compra: es el borrador que se lee de fondo, se revisa y recién después
-- precarga el formulario de Compras. `photos`, `pages_text`, `header` y `lines`
-- son JSON en texto. `status`: recibiendo | en_cola | leyendo | lista | error |
-- cargada | descartada (sin CHECK a propósito: sumar un estado no debe obligar
-- a recrear la tabla). Si se borra el proveedor, la factura queda sin proveedor.
CREATE TABLE IF NOT EXISTS `scanned_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'recibiendo' NOT NULL,
	`supplier_id` text,
	`photos` text DEFAULT '[]' NOT NULL,
	`pages_text` text DEFAULT '[]' NOT NULL,
	`header` text,
	`lines` text DEFAULT '[]' NOT NULL,
	`error` text,
	`pages_done` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scanned_invoices_status` ON `scanned_invoices` (`status`,`created_at`);
