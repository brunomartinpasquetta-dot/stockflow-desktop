-- Auditoría sep-2026 (A8): el desglose efectivo/electrónico de cada movimiento
-- de Caja General sólo quedaba en los saldos acumulados (balance_after_*). Al
-- completar un depósito parcial de un cierre, la pantalla tenía que ADIVINAR
-- cuánto de lo ya ingresado era efectivo y cuánto electrónico. Ahora cada
-- movimiento guarda su propio desglose. Nullable: las filas viejas se
-- reconstruyen por diferencia de saldos.
ALTER TABLE `cash_general_movements` ADD `cash_amount` text;--> statement-breakpoint
ALTER TABLE `cash_general_movements` ADD `electronic_amount` text;
