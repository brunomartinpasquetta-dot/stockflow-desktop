-- Integración con el CATÁLOGO WEB del comercio (producto aparte, en
-- desarrollo): el sistema guarda la dirección y la clave de acceso del
-- catálogo del cliente. Con estos datos cargados, Estadísticas muestra la
-- pestaña "Catálogo web" (visitas, más vistos, más comprados, búsquedas).
-- NULL = sin catálogo integrado: la pestaña no aparece.
ALTER TABLE `companies` ADD COLUMN `catalogo_url` text;--> statement-breakpoint
ALTER TABLE `companies` ADD COLUMN `catalogo_token` text;
