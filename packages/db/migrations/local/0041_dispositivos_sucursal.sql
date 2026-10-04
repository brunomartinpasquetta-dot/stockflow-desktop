-- MULTISUCURSAL: PC de sucursal emparejadas con el servidor (ver docs/PLAN_MULTISUCURSAL.md).
--
-- Sólo AGREGA una tabla. Un comercio que no usa multisucursal nunca escribe
-- acá y no nota nada.
--
-- Cada fila es una PC que canjeó un código de emparejamiento. El servidor
-- guarda SÓLO el hash SHA-256 del token (32 bytes al azar): si alguien se
-- lleva la base, no puede hacerse pasar por la PC. `machine_id` es el de la
-- terminal (con él el servidor sabe qué caja es suya aunque la PC mande otro
-- encabezado). `estado`: activo | revocado (sin CHECK a propósito, como en
-- `scanned_invoices`: sumar un estado no debe obligar a recrear la tabla).
-- Se revoca, nunca se borra: queda para la auditoría.
CREATE TABLE IF NOT EXISTS `dispositivos_sucursal` (
	`id` text PRIMARY KEY NOT NULL,
	`nombre` text NOT NULL,
	`machine_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`estado` text DEFAULT 'activo' NOT NULL,
	`creado_en` integer NOT NULL,
	`creado_por` text,
	`ultimo_uso_en` integer,
	`revocado_en` integer,
	`revocado_por` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_dispositivos_sucursal_machine` ON `dispositivos_sucursal` (`machine_id`);
