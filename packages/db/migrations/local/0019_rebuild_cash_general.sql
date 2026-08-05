-- Caja General: reconstruir el saldo desde los movimientos que REALMENTE existen.
--
-- Dos fallas se combinaron:
--
--  1. El reinicio de datos operativos, hasta v0.1.92, ponía `current_balance = 0`
--     pero NO limpiaba `cash_balance` ni `electronic_balance` (esas columnas se
--     habían agregado en esa misma versión y el reset no las contemplaba).
--  2. `applyMovement` calculaba el total como cash + electronic. Al operar
--     después del reinicio, el saldo viejo —que seguía vivo en el desglose—
--     RESUCITABA en el total.
--
-- Resultado para el usuario: reinició la caja a cero y el saldo volvió a aparecer.
--
-- La 0018 ya arregló el desglose, pero asumía que `current_balance` era correcto.
-- Cuando el reinicio borró los movimientos, ese saldo quedó inflado sin respaldo.
--
-- Acá se reconstruye TODO desde `cash_general_movements`, que es el libro real:
-- cada movimiento es un hecho registrado y su suma es, por definición, el saldo.
-- No se borra ni modifica ningún movimiento — solo se recalculan los acumulados.

-- 1) Total = suma de los movimientos existentes (ingresos y depósitos suman,
--    egresos restan). Si el reinicio los borró, el saldo queda en 0, que es lo
--    que el usuario pidió al reiniciar.
UPDATE `cash_general`
SET `current_balance` = (
  SELECT COALESCE(SUM(
    CASE WHEN `type` IN ('income', 'transfer_from_daily')
         THEN CAST(`amount` AS REAL)
         ELSE -CAST(`amount` AS REAL) END
  ), 0)
  FROM `cash_general_movements`
);
--> statement-breakpoint
-- 2) Electrónico = suma de los movimientos marcados como no-efectivo.
UPDATE `cash_general`
SET `electronic_balance` = (
  SELECT COALESCE(SUM(
    CASE WHEN `type` IN ('income', 'transfer_from_daily')
         THEN CAST(`amount` AS REAL)
         ELSE -CAST(`amount` AS REAL) END
  ), 0)
  FROM `cash_general_movements`
  WHERE `is_cash` = 0
);
--> statement-breakpoint
-- 3) Efectivo = el resto, para que efectivo + electrónico == total siempre.
UPDATE `cash_general`
SET `cash_balance` = CAST(`current_balance` AS REAL) - CAST(`electronic_balance` AS REAL);
--> statement-breakpoint
-- 4) Sin saldos negativos imposibles: si el desglose no cierra (histórico previo
--    sin discriminar), se atribuye todo a la columna que corresponda.
UPDATE `cash_general`
SET `cash_balance` = '0', `electronic_balance` = `current_balance`
WHERE CAST(`cash_balance` AS REAL) < 0;
--> statement-breakpoint
UPDATE `cash_general`
SET `electronic_balance` = '0', `cash_balance` = `current_balance`
WHERE CAST(`electronic_balance` AS REAL) < 0;
