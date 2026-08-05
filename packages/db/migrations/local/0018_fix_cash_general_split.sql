-- FIX: desglose efectivo/electrónico de Caja General desincronizado del total.
--
-- Qué pasó: la migración 0015 hizo `cash_balance = current_balance` y
-- `electronic_balance = 0`, asumiendo que TODO el saldo histórico era efectivo.
-- En una caja que ya venía operando, parte de ese saldo venía de transferencias
-- y tarjetas. Al operar después, el electrónico se acumuló sobre una base cero y
-- el total pasó a calcularse como cash + electronic, quedando desviado.
--
-- Caso real: efectivo 442.317,09 + electrónico 807.504,89 = 1.249.821,98 contra
-- un total real de 799.821,98 → $450.000 de descuadre.
--
-- Arreglo, SIN PERDER DATOS: el `current_balance` y el historial de movimientos
-- (incluido `balance_after`) están correctos y NO se tocan. Solo se recalculan
-- las dos columnas del desglose a partir de los movimientos registrados, y se
-- asigna la diferencia no atribuible (el saldo previo a 0015, que no tiene
-- discriminación) a efectivo.

-- 1) Recalcular el desglose sumando los movimientos por naturaleza.
--    Los movimientos anteriores a 0015 quedaron con is_cash=1 por defecto, así
--    que se suman como efectivo — es la mejor atribución posible y mantiene la
--    identidad efectivo + electrónico = total.
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
-- 2) El efectivo es el resto: garantiza que efectivo + electrónico == total,
--    que es la invariante que se había roto. `current_balance` manda porque su
--    historial (verificado contra balance_after) siempre fue correcto.
UPDATE `cash_general`
SET `cash_balance` = CAST(`current_balance` AS REAL) - CAST(`electronic_balance` AS REAL);
--> statement-breakpoint
-- 3) Un efectivo NEGATIVO es imposible en la realidad y confunde tanto como el
--    descuadre. Pasa cuando el electrónico acumulado supera al total, porque el
--    saldo previo a 0015 no tiene discriminación. En ese caso se lleva el
--    efectivo a 0 y el electrónico absorbe el total: la plata está toda ahí, es
--    la atribución más honesta con la información disponible. El comercio puede
--    reasignar con un movimiento si conoce el reparto real.
UPDATE `cash_general`
SET `cash_balance` = '0',
    `electronic_balance` = `current_balance`
WHERE CAST(`cash_balance` AS REAL) < 0;
--> statement-breakpoint
-- 4) Simétrico: electrónico negativo → todo a efectivo.
UPDATE `cash_general`
SET `electronic_balance` = '0',
    `cash_balance` = `current_balance`
WHERE CAST(`electronic_balance` AS REAL) < 0;
