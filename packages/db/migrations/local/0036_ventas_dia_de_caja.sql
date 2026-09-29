-- DÍA DE CAJA ("jornada") de cada venta y cada devolución.
--
-- Pedido de Bruno (29-sep-2026): si la caja se abre el lunes y se cierra el
-- martes a la 1:30, todo lo vendido con esa caja es del LUNES. Los filtros por
-- día (historial, estadísticas, contabilidad) miraban la hora de la venta y
-- mandaban lo de después de medianoche al martes.
--
-- Regla: la venta cuenta para el momento de APERTURA de su caja si se hizo
-- dentro de las 24 h siguientes a esa apertura. Si no —una caja olvidada
-- abierta varios días, o la "Caja histórica" de una migración, que se abre el
-- día de la migración y cuelga ventas de años—, cuenta por su propia hora.
-- Nunca se mueve una venta a un día ANTERIOR a su caja ni más de 24 h atrás.
--
-- Se guarda como columna (con índice) en vez de calcularse en cada consulta:
-- son ~30 filtros, y así cada uno sólo cambia qué columna mira. Los triggers la
-- completan en TODO insert (la app, la conversión de pedidos web y también las
-- herramientas de migración, que insertan directo en SQLite).
-- Lo FISCAL (Libro IVA, comprobantes ARCA) NO usa esto: va por la fecha del
-- comprobante.
ALTER TABLE `sales` ADD `jornada` integer;--> statement-breakpoint
UPDATE `sales` SET `jornada` = COALESCE(
  (SELECT CASE WHEN cr.open_date <= `sales`.`date` AND `sales`.`date` - cr.open_date < 86400000 THEN cr.open_date END
     FROM `cash_registers` cr WHERE cr.id = `sales`.`cash_register_id`),
  `sales`.`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sales_jornada` ON `sales` (`jornada`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_sales_jornada_ins` AFTER INSERT ON `sales`
BEGIN
  UPDATE `sales` SET `jornada` = COALESCE(
    (SELECT CASE WHEN cr.open_date <= NEW.`date` AND NEW.`date` - cr.open_date < 86400000 THEN cr.open_date END
       FROM `cash_registers` cr WHERE cr.id = NEW.`cash_register_id`),
    NEW.`date`)
  WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_sales_jornada_upd` AFTER UPDATE OF `date`, `cash_register_id` ON `sales`
BEGIN
  UPDATE `sales` SET `jornada` = COALESCE(
    (SELECT CASE WHEN cr.open_date <= NEW.`date` AND NEW.`date` - cr.open_date < 86400000 THEN cr.open_date END
       FROM `cash_registers` cr WHERE cr.id = NEW.`cash_register_id`),
    NEW.`date`)
  WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
ALTER TABLE `returns` ADD `jornada` integer;--> statement-breakpoint
UPDATE `returns` SET `jornada` = COALESCE(
  (SELECT CASE WHEN cr.open_date <= `returns`.`date` AND `returns`.`date` - cr.open_date < 86400000 THEN cr.open_date END
     FROM `cash_registers` cr WHERE cr.id = `returns`.`cash_register_id`),
  `returns`.`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_returns_jornada` ON `returns` (`jornada`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_returns_jornada_ins` AFTER INSERT ON `returns`
BEGIN
  UPDATE `returns` SET `jornada` = COALESCE(
    (SELECT CASE WHEN cr.open_date <= NEW.`date` AND NEW.`date` - cr.open_date < 86400000 THEN cr.open_date END
       FROM `cash_registers` cr WHERE cr.id = NEW.`cash_register_id`),
    NEW.`date`)
  WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `trg_returns_jornada_upd` AFTER UPDATE OF `date`, `cash_register_id` ON `returns`
BEGIN
  UPDATE `returns` SET `jornada` = COALESCE(
    (SELECT CASE WHEN cr.open_date <= NEW.`date` AND NEW.`date` - cr.open_date < 86400000 THEN cr.open_date END
       FROM `cash_registers` cr WHERE cr.id = NEW.`cash_register_id`),
    NEW.`date`)
  WHERE `id` = NEW.`id`;
END;
