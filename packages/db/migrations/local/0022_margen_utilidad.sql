-- UTILIDAD POR LISTA DE PRECIOS.
--
-- El comercio piensa el precio como costo + utilidad. Al cargar una compra con
-- un costo nuevo, el sistema puede recalcular TODAS las listas del artículo
-- respetando el margen de cada una — para eso el margen tiene que vivir en el
-- artículo, uno POR LISTA (cada lista tiene su propia relación con el costo).
--
-- Se SIEMBRAN solos desde los datos que ya existen (margen = precio/costo - 1):
-- nadie carga doce mil porcentajes a mano. NULL = sin margen conocido (costo o
-- precio en cero): esa lista no se recalcula nunca hasta que alguien lo cargue.
--
-- Todo con IVA incluido, como trabajan los clientes (priceMode 'gross'):
-- margen sobre costo c/IVA da precio c/IVA. No se mezclan bases.
ALTER TABLE `articles` ADD COLUMN `margin1` text;
--> statement-breakpoint
ALTER TABLE `articles` ADD COLUMN `margin2` text;
--> statement-breakpoint
ALTER TABLE `articles` ADD COLUMN `margin3` text;
--> statement-breakpoint
UPDATE `articles` SET `margin1` = printf('%.2f', (CAST(`list_price1` AS REAL) / CAST(`cost_price` AS REAL) - 1) * 100)
WHERE CAST(`cost_price` AS REAL) > 0 AND CAST(`list_price1` AS REAL) > 0;
--> statement-breakpoint
UPDATE `articles` SET `margin2` = printf('%.2f', (CAST(`list_price2` AS REAL) / CAST(`cost_price` AS REAL) - 1) * 100)
WHERE CAST(`cost_price` AS REAL) > 0 AND CAST(`list_price2` AS REAL) > 0;
--> statement-breakpoint
UPDATE `articles` SET `margin3` = printf('%.2f', (CAST(`list_price3` AS REAL) / CAST(`cost_price` AS REAL) - 1) * 100)
WHERE CAST(`cost_price` AS REAL) > 0 AND CAST(`list_price3` AS REAL) > 0;
