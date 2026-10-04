-- MULTISUCURSAL (ver docs/PLAN_MULTISUCURSAL.md): edición de StockFlow que
-- tiene contratada cada comercio.
--   'comun'         = StockFlow de siempre (todos los clientes de hoy).
--   'multisucursal' = habilita Configuración → Sucursales y lo que venga atrás.
--
-- Va en `tenants` y no en `licenses`: es una propiedad del COMERCIO, no de
-- cada PC. Un comercio con varias cajas tiene varias licencias y todas deben
-- ver lo mismo; así se cambia en un solo lugar, igual que `plan` y
-- `licenses_quota`, que ya viven acá.
--
-- Aditiva: la columna nace con 'comun' para todas las filas existentes. Se
-- aplica a mano como la 0002, ANTES de reiniciar el servicio con el código
-- nuevo:
--   psql "$DATABASE_URL" -f packages/db/migrations/cloud/0003_tenant_edicion.sql
-- Red de seguridad: al arrancar, el cloud verifica la columna y, si falta, corre
-- estas mismas sentencias (apps/cloud/src/esquema.ts); si no puede, no arranca
-- (mejor un deploy que no levanta que licencias que fallan para todos).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS edicion varchar(16) NOT NULL DEFAULT 'comun';
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_edicion_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_edicion_check CHECK (edicion IN ('comun', 'multisucursal'));
