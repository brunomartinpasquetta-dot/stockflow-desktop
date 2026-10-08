-- Cambio que queda en el cajón para la próxima apertura (pedido de Bruno,
-- 8-oct-2026). Hasta ahora el comercio hacía un EGRESO MANUAL por ese dinero,
-- que es justamente lo que descuadraba el arqueo y hacía depositar de menos.
-- Ahora el cierre lo pregunta, lo descuenta solo de lo que va a Caja General y
-- lo propone como apertura del turno siguiente.
ALTER TABLE cash_registers ADD COLUMN change_left text;
--> statement-breakpoint
-- Quién CERRÓ la caja. El reimpreso del historial rotulaba «Cajero» a quien la
-- había ABIERTO, que en un local con turnos no es la misma persona.
ALTER TABLE cash_registers ADD COLUMN closed_by_user_id text;
