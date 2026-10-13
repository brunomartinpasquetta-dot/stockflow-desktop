-- Anular una cobranza de cliente o un pago a proveedor (Bruno, 13-oct-2026:
-- «si me equivoqué de cliente, ¿puedo revertir ese cobro?»). Hasta acá no había
-- forma: el cobro quedaba aplicado a la cuenta equivocada y la única salida era
-- un ajuste a mano.
--
-- No se borra nada: el pago queda con su fecha y se marca anulado (quién,
-- cuándo, por qué). La deuda vuelve a la cuenta y el dinero sale/vuelve con un
-- movimiento nuevo en la caja que corresponda (la abierta de hoy si la del pago
-- ya cerró; Caja General si el pago salió de ahí).
ALTER TABLE payments ADD COLUMN voided_at integer;
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN voided_by text;
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN void_reason text;
--> statement-breakpoint
ALTER TABLE supplier_payments ADD COLUMN voided_at integer;
--> statement-breakpoint
ALTER TABLE supplier_payments ADD COLUMN voided_by text;
--> statement-breakpoint
ALTER TABLE supplier_payments ADD COLUMN void_reason text;
