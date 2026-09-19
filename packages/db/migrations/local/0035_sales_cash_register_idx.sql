-- Auditoría sep-2026: abrir la caja del día y armar su arqueo recorría TODA la
-- tabla de ventas (SCAN) porque sales.cash_register_id no tenía índice. Con
-- 60.000 ventas migradas se notaba en cada apertura.
CREATE INDEX IF NOT EXISTS `idx_sales_cash_register` ON `sales` (`cash_register_id`);
