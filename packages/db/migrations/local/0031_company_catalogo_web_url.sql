-- Dirección PÚBLICA de la tienda, para verla embebida desde "Catálogo web →
-- Ver catálogo". Normalmente es la misma que la del catálogo (API y tienda en
-- el mismo dominio); se completa sólo cuando difieren (p.ej. API en un puerto
-- y tienda en otro). Vacía = se usa `catalogo_url`.
ALTER TABLE `companies` ADD `catalogo_web_url` text;
