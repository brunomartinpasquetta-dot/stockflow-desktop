-- VENTAS Y COMPRAS SIN DUPLICAR cuando se corta la conexión (ítem 13 del plan
-- multisucursal, docs/PLAN_MULTISUCURSAL.md §10.2).
--
-- La pantalla genera una clave única por intento de cobro y la manda con la
-- venta. Si la respuesta se pierde (red local que se cae, túnel lento) y el
-- cajero vuelve a cobrar el MISMO carrito, viaja la misma clave y el servidor
-- devuelve la venta ya registrada en vez de crear otra (y descontar el stock
-- y cobrar en caja dos veces).
--
-- Sólo AGREGA columnas que aceptan NULL: las ventas y compras de siempre (y
-- las de terminales viejas que no mandan clave) quedan con NULL, y el índice
-- único admite cualquier cantidad de NULL. ALTER TABLE ADD no toca los
-- triggers de la 0036 (`jornada`).
ALTER TABLE `sales` ADD `idempotency_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_sales_idempotency_key` ON `sales` (`idempotency_key`);
--> statement-breakpoint
ALTER TABLE `purchases` ADD `idempotency_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_purchases_idempotency_key` ON `purchases` (`idempotency_key`);
