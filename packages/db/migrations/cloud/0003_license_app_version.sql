-- Versión de StockFlow que corre cada comercio, informada en el heartbeat.
-- Hasta ahora no había forma de saber quién se había quedado atrás: si la
-- actualización automática fallaba en una PC, el comercio seguía con una
-- versión vieja y nadie se enteraba (7-oct-2026).
-- Additive: la columna es opcional y el código anterior la ignora.
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS app_version varchar(24);
