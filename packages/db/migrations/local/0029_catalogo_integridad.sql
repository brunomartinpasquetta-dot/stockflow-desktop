-- Auditoría de packages/db (11-sep-2026): a `catalogo_pedidos` le faltaban
-- las mismas protecciones que tiene toda tabla comparable en este esquema —
-- FK de `sale_id` hacia `sales` (como `quotes.sale_id`) y CHECK en los dos
-- campos de estado (como `sales.status`, `quotes.status`, `articles.unit`).
-- SQLite no permite agregar eso con ALTER TABLE: hay que recrear la tabla.
--
-- Y a `articles` le faltaba el índice sobre `updated_at`, que el espejo del
-- catálogo web filtra y ordena en cada corrida (cada 60 s, con el espejo
-- activo) — sin índice es un table scan completo más un sort, siempre.
CREATE INDEX `idx_articles_updated_at` ON `articles` (`updated_at`);--> statement-breakpoint
CREATE TABLE `__new_catalogo_pedidos` (
	`id` text PRIMARY KEY NOT NULL,
	`pedido_id` text NOT NULL,
	`numero` integer NOT NULL,
	`fecha` integer NOT NULL,
	`cliente_nombre` text NOT NULL,
	`cliente_telefono` text,
	`cliente_email` text,
	`entrega` text DEFAULT 'retiro' NOT NULL,
	`direccion` text,
	`notas` text,
	`total` text DEFAULT '0.0000' NOT NULL,
	`items` text NOT NULL,
	`estado` text DEFAULT 'pendiente' NOT NULL,
	`sale_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "catalogo_pedidos_entrega_check" CHECK("__new_catalogo_pedidos"."entrega" in ('retiro', 'envio')),
	CONSTRAINT "catalogo_pedidos_estado_check" CHECK("__new_catalogo_pedidos"."estado" in ('pendiente', 'convertido', 'rechazado'))
);
--> statement-breakpoint
INSERT INTO `__new_catalogo_pedidos` (`id`, `pedido_id`, `numero`, `fecha`, `cliente_nombre`, `cliente_telefono`, `cliente_email`, `entrega`, `direccion`, `notas`, `total`, `items`, `estado`, `sale_id`, `created_at`, `updated_at`)
	SELECT `id`, `pedido_id`, `numero`, `fecha`, `cliente_nombre`, `cliente_telefono`, `cliente_email`, `entrega`, `direccion`, `notas`, `total`, `items`, `estado`, `sale_id`, `created_at`, `updated_at` FROM `catalogo_pedidos`;
--> statement-breakpoint
DROP TABLE `catalogo_pedidos`;--> statement-breakpoint
ALTER TABLE `__new_catalogo_pedidos` RENAME TO `catalogo_pedidos`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_catalogo_pedidos_pedido` ON `catalogo_pedidos` (`pedido_id`);--> statement-breakpoint
CREATE INDEX `idx_catalogo_pedidos_estado` ON `catalogo_pedidos` (`estado`);
