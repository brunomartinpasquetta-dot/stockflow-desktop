-- Dar de baja proveedores en vez de borrarlos (pedido de Bruno, 8-oct-2026).
-- Un proveedor con compras cargadas no se puede borrar: el borrado fallaba con
-- «FOREIGN KEY constraint failed» y el comercio no tenía forma de sacarlo de la
-- lista. Dado de baja deja de aparecer para elegir y el historial sigue
-- mostrando de quién se compró. Mismo criterio que los artículos.
ALTER TABLE suppliers ADD COLUMN active integer NOT NULL DEFAULT 1;
