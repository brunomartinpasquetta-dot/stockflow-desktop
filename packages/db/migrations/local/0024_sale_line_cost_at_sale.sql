-- MARGEN HISTÓRICO REAL: las líneas de venta congelan el costo del artículo
-- al momento de vender. Hasta ahora el margen de Estadísticas/Contabilidad se
-- calculaba con el costo ACTUAL del artículo: cada reprecio distorsionaba la
-- ganancia de todo el pasado. Las filas viejas quedan NULL (sin dato real) y
-- los cálculos usan COALESCE(cost_at_sale, costo actual) — el margen se
-- vuelve exacto para las ventas nuevas y aproximado para las anteriores.
ALTER TABLE `sale_lines` ADD COLUMN `cost_at_sale` text;
