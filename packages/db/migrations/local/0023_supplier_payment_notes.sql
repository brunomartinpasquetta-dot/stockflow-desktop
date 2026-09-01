-- Espejo con la tabla `payments` de clientes: las cobranzas guardan `notes`
-- pero los pagos a proveedor lo aceptaban en el input y lo descartaban en
-- silencio. Ahora se persiste (nullable; las filas viejas quedan NULL).
ALTER TABLE `supplier_payments` ADD COLUMN `notes` text;
