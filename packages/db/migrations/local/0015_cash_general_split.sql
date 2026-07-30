-- Caja General: discriminar saldo EFECTIVO vs ELECTRÓNICO (como la caja diaria).
-- Cada movimiento marca si es efectivo (is_cash=1) o electrónico (is_cash=0).
-- El singleton lleva dos saldos; current_balance sigue siendo la suma (retrocompat).
ALTER TABLE `cash_general_movements` ADD COLUMN `is_cash` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `cash_general_movements` ADD COLUMN `balance_after_cash` text NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE `cash_general_movements` ADD COLUMN `balance_after_electronic` text NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE `cash_general` ADD COLUMN `cash_balance` text NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE `cash_general` ADD COLUMN `electronic_balance` text NOT NULL DEFAULT '0';
--> statement-breakpoint
-- Datos históricos: al no haber discriminado antes, se asume todo el saldo
-- acumulado como EFECTIVO (is_cash=1 por defecto). El usuario puede ajustar con
-- movimientos si hiciera falta; lo importante es que current_balance = cash + electronic.
UPDATE `cash_general` SET `cash_balance` = `current_balance`, `electronic_balance` = '0';
