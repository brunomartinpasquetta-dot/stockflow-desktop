-- Auditoría sep-2026 (B5): "crear_faltantes" se mandaba siempre en true, así
-- que hasta los artículos dados de BAJA se creaban (ocultos) en el catálogo.
-- Ahora es configurable por empresa y sólo aplica a los artículos activos.
ALTER TABLE `catalogo_sync` ADD `crear_faltantes` integer NOT NULL DEFAULT 1;
