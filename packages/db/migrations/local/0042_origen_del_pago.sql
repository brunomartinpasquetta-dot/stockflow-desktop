-- De dónde salió la plata de un pago a proveedor, y poder corregirlo.
--
-- El caso real (cliente, 8-oct-2026): pagaron una factura eligiendo «caja
-- diaria» cuando el dinero salió de Caja General. No había forma de arreglarlo:
-- el pago no guardaba su origen y el movimiento de caja no quedaba enlazado al
-- pago, así que ni siquiera se podía saber cuál movimiento correspondía a cuál
-- pago.
--
-- Con el enlace, «Corregir el origen» mueve el egreso de un lado al otro sin
-- tocar la deuda con el proveedor: la factura sigue pagada, lo único que cambia
-- es de qué caja salió.
ALTER TABLE cash_movements ADD COLUMN supplier_payment_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cash_movements_supplier_payment
  ON cash_movements (supplier_payment_id);
--> statement-breakpoint
ALTER TABLE cash_general_movements ADD COLUMN supplier_payment_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cash_general_supplier_payment
  ON cash_general_movements (supplier_payment_id);
--> statement-breakpoint
-- De dónde salió la plata, guardado en el propio pago. Inferirlo mirando los
-- movimientos no sirve: después de una corrección quedan movimientos en las
-- DOS cajas (el egreso y su devolución), y el sistema creía que el origen
-- seguía siendo el viejo.
ALTER TABLE supplier_payments ADD COLUMN funding_source text;
