-- ARTÍCULO RÁPIDO: vender algo que no está en el catálogo.
--
-- El comercio necesita cobrar cosas que no tiene cargadas: una changa, un
-- artículo suelto, algo que entró hoy y todavía no se dio de alta. Hoy no hay
-- forma: toda línea de venta exige un artículo existente.
--
-- POR QUÉ NO SE COPIA A StockFácil. Allá el botón "Artículo Rápido [F10]" crea
-- un artículo NUEVO cada vez, con código '0000' y oculto del listado. Medido en
-- la base real de Leo Citzia: **10.323 de sus 12.432 artículos son eso** — el
-- 83% del catálogo es basura de un solo uso, cada uno con stock negativo. Por
-- eso StockFácil muestra 2.109 artículos: esconde los otros diez mil.
--
-- Acá la línea guarda su propia descripción y NO apunta a ningún artículo. El
-- catálogo queda intacto y el conteo de artículos sigue significando algo.
--
-- Dos cambios sobre `sale_lines`:
--   1. `article_id` pasa a aceptar NULL (línea sin artículo).
--   2. `description` guarda lo que escribió el cajero. Sólo se usa cuando no
--      hay artículo; con artículo, la descripción sigue saliendo de él (que es
--      la que se actualiza si se lo renombra).
--
-- SQLite no permite quitar un NOT NULL con ALTER: hay que recrear la tabla.
-- `initLocalDb` corre las migraciones con `foreign_keys = OFF`, así que el
-- DROP/RENAME no rompe la referencia de `return_lines.sale_line_id` — los ids
-- se preservan tal cual, no se regenera ninguno.

CREATE TABLE `sale_lines_new` (
  `id` text PRIMARY KEY NOT NULL,
  `sale_id` text NOT NULL REFERENCES `sales`(`id`) ON DELETE cascade,
  `article_id` text REFERENCES `articles`(`id`),
  `description` text,
  `line_number` integer NOT NULL,
  `quantity` text NOT NULL,
  `unit_price` text NOT NULL,
  `discount` text DEFAULT '0.0000' NOT NULL,
  `vat_rate` text DEFAULT '21.00' NOT NULL,
  `line_total` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `sale_lines_new`
  (`id`, `sale_id`, `article_id`, `description`, `line_number`, `quantity`,
   `unit_price`, `discount`, `vat_rate`, `line_total`, `created_at`)
SELECT `id`, `sale_id`, `article_id`, NULL, `line_number`, `quantity`,
       `unit_price`, `discount`, `vat_rate`, `line_total`, `created_at`
FROM `sale_lines`;
--> statement-breakpoint
DROP TABLE `sale_lines`;
--> statement-breakpoint
ALTER TABLE `sale_lines_new` RENAME TO `sale_lines`;
--> statement-breakpoint
CREATE INDEX `idx_sale_lines_sale` ON `sale_lines` (`sale_id`);
--> statement-breakpoint

-- Y lo mismo en las devoluciones: si `return_lines.article_id` siguiera siendo
-- obligatorio, una venta con artículo rápido no se podría devolver NUNCA — se
-- le cobró al cliente y no habría forma de reintegrarle la plata. La devolución
-- de un artículo rápido es sólo dinero: no hay stock que reponer.
CREATE TABLE `return_lines_new` (
  `id` text PRIMARY KEY NOT NULL,
  `return_id` text NOT NULL REFERENCES `returns`(`id`) ON DELETE cascade,
  `sale_line_id` text NOT NULL REFERENCES `sale_lines`(`id`),
  `article_id` text REFERENCES `articles`(`id`),
  `quantity` text NOT NULL,
  `unit_price` text NOT NULL,
  `line_total` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `return_lines_new`
  (`id`, `return_id`, `sale_line_id`, `article_id`, `quantity`, `unit_price`,
   `line_total`, `created_at`)
SELECT `id`, `return_id`, `sale_line_id`, `article_id`, `quantity`, `unit_price`,
       `line_total`, `created_at`
FROM `return_lines`;
--> statement-breakpoint
DROP TABLE `return_lines`;
--> statement-breakpoint
ALTER TABLE `return_lines_new` RENAME TO `return_lines`;
--> statement-breakpoint
CREATE INDEX `idx_return_lines_return` ON `return_lines` (`return_id`);
--> statement-breakpoint
CREATE INDEX `idx_return_lines_sale_line` ON `return_lines` (`sale_line_id`);
