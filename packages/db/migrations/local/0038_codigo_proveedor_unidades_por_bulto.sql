-- FACTURAS DE COMPRA POR TELÉFONO (ver docs/PLAN_FACTURAS_TELEFONO.md).
--
-- Sólo AGREGA una columna a `article_supplier_codes`: las unidades por bulto
-- que el usuario confirmó para ese código de ese proveedor (la factura cotiza
-- por cajón y el artículo del comercio es la unidad). La próxima factura las
-- propone sola. NULL = todavía no se confirmó nada.
ALTER TABLE `article_supplier_codes` ADD COLUMN `units_per_pack` real;
