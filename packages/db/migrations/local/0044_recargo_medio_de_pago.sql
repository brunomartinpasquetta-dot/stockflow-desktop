-- Recargo por medio de pago (1.18.4): porcentaje que paga el CLIENTE por usar
-- ese medio (por ejemplo, 10 % con tarjeta de crédito). Distinto de la
-- comisión, que la absorbe el comercio. Nace en 0 para todos los medios: nada
-- cambia hasta que el comercio lo cargue en Medios de pago.
ALTER TABLE `payment_methods` ADD COLUMN `surcharge_pct` text NOT NULL DEFAULT '0.00';
