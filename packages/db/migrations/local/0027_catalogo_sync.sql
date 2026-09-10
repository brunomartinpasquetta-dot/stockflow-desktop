-- ESPEJO DEL CATÁLOGO WEB. Estado del sincronizador que empuja los artículos
-- (código, nombre, precio, stock disponible) al catálogo online del comercio.
-- Fila única 'singleton'.
--
-- `cursor` es la marca de agua sobre articles.updated_at: se empuja lo que
-- cambió después. Arranca en 0 → la primera corrida manda todo.
CREATE TABLE `catalogo_sync` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_ok_at` integer,
	`last_error` text,
	`pushed_total` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
