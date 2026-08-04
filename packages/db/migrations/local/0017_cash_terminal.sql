-- CAJA POR TERMINAL (instalaciones con varios puestos en red).
--
-- Hasta ahora había UNA sola caja diaria para todo el negocio: el primer puesto
-- que abría bloqueaba a los demás ("Ya hay una caja abierta"), los tres vendían
-- contra la misma caja y el arqueo no se podía conciliar por cajón físico.
--
-- Con `terminal_id` cada puesto abre y cierra su propia caja, y el cierre cuadra
-- contra el cajón de esa terminal.
--
-- Las cajas existentes quedan con terminal_id NULL = "caja del sistema", que se
-- sigue comportando como antes (compartida). Así una instalación de una sola PC
-- no cambia en nada.
ALTER TABLE `cash_registers` ADD COLUMN `terminal_id` text;
--> statement-breakpoint
ALTER TABLE `cash_registers` ADD COLUMN `terminal_name` text;
--> statement-breakpoint
CREATE INDEX `idx_cash_registers_terminal` ON `cash_registers` (`terminal_id`, `status`);
