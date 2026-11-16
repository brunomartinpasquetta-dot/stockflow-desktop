-- Cuentas corrientes traídas de StockFácil (1.18.6). La migración dejaba el
-- saldo inicial ya NETO de las entregas viejas y además traía esas entregas,
-- así que el estado de cuenta (y el Resumen PDF) las descontaba dos veces: el
-- saldo renglón a renglón se iba a negativo mientras el saldo real, abajo,
-- estaba bien. El saldo inicial pasa a ser la deuda ANTES de esas entregas:
-- total = saldo + entregas, y la cuenta cierra sola. Sólo toca cuentas que
-- cuelgan de una venta sintética de StockFácil y cuyas entregas superan lo
-- aplicado; el saldo adeudado, la caja y las ventas hechas en StockFlow no
-- cambian. Es idempotente: la segunda vez no encuentra nada que corregir.
-- Los importes son TEXT: se comparan como REAL (si no, SQLite compara texto y
-- «98400» queda «mayor» que «610700»).
UPDATE `accounts_receivable` SET
  `total` = printf('%.4f', CAST(`balance` AS REAL) + (SELECT COALESCE(SUM(CAST(p.`amount` AS REAL)), 0) FROM `payments` p WHERE p.`account_id` = `accounts_receivable`.`id` AND p.`voided_at` IS NULL)),
  `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `sale_id` IN (SELECT `id` FROM `sales` WHERE `notes` LIKE 'Saldo%StockFácil%')
  AND CAST(`total` AS REAL) + 0.005 < CAST(`balance` AS REAL) + (SELECT COALESCE(SUM(CAST(p.`amount` AS REAL)), 0) FROM `payments` p WHERE p.`account_id` = `accounts_receivable`.`id` AND p.`voided_at` IS NULL);
--> statement-breakpoint
-- El renglón «Consumos anteriores de cuenta corriente (StockFácil)» de la venta
-- sintética, si lo hay, absorbe la diferencia para que la venta siga cerrando
-- con sus renglones.
UPDATE `sale_lines` SET
  `unit_price` = printf('%.4f', CAST(`unit_price` AS REAL) + (SELECT CAST(a.`total` AS REAL) - CAST(s.`total` AS REAL) FROM `sales` s JOIN `accounts_receivable` a ON a.`sale_id` = s.`id` WHERE s.`id` = `sale_lines`.`sale_id`)),
  `line_total` = printf('%.4f', CAST(`line_total` AS REAL) + (SELECT CAST(a.`total` AS REAL) - CAST(s.`total` AS REAL) FROM `sales` s JOIN `accounts_receivable` a ON a.`sale_id` = s.`id` WHERE s.`id` = `sale_lines`.`sale_id`))
WHERE `sale_id` IN (
    SELECT s.`id` FROM `sales` s JOIN `accounts_receivable` a ON a.`sale_id` = s.`id`
    WHERE s.`notes` LIKE 'Saldo%StockFácil%' AND CAST(s.`total` AS REAL) + 0.005 < CAST(a.`total` AS REAL)
  )
  AND `article_id` IN (SELECT `id` FROM `articles` WHERE `description` LIKE 'Consumos anteriores de cuenta corriente%');
--> statement-breakpoint
UPDATE `sales` SET
  `subtotal` = printf('%.4f', (SELECT CAST(a.`total` AS REAL) FROM `accounts_receivable` a WHERE a.`sale_id` = `sales`.`id`) - CAST(`vat_amount` AS REAL) + CAST(`discount` AS REAL)),
  `total` = (SELECT a.`total` FROM `accounts_receivable` a WHERE a.`sale_id` = `sales`.`id`),
  `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `notes` LIKE 'Saldo%StockFácil%'
  AND CAST(`total` AS REAL) + 0.005 < (SELECT CAST(a.`total` AS REAL) FROM `accounts_receivable` a WHERE a.`sale_id` = `sales`.`id`);
