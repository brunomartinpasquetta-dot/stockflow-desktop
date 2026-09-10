-- PEDIDOS DEL CATÁLOGO WEB bajados al sistema.
--
-- Un pedido web NO es una venta todavía: entra acá, el comerciante lo revisa y
-- recién al confirmarlo se convierte en venta con su movimiento de stock, su
-- caja y su comprobante. Vender de una sería imposible: una venta exige caja
-- abierta y forma de pago, y un pedido de las 3 de la mañana no tiene ninguna
-- de las dos.
--
-- `pedido_id` es el id del pedido EN EL CATÁLOGO y es único: es lo que impide
-- que el mismo pedido entre dos veces si se corta la conexión después de
-- bajarlo y antes de avisar que se tomó.
CREATE TABLE `catalogo_pedidos` (
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_catalogo_pedidos_pedido` ON `catalogo_pedidos` (`pedido_id`);--> statement-breakpoint
CREATE INDEX `idx_catalogo_pedidos_estado` ON `catalogo_pedidos` (`estado`);
