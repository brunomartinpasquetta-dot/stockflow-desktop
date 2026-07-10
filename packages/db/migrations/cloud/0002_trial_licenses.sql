-- Licencias de PRUEBA GRATIS (30 días, autoservicio desde el desktop).
-- kind: 'paid' (normal) | 'trial' (se crea sola desde la pantalla de Activación).
-- expires_at: fin de la prueba (solo kind='trial'; las pagas siguen sin vencimiento acá).
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS kind varchar(8) NOT NULL DEFAULT 'paid';
ALTER TABLE licenses ADD COLUMN IF NOT EXISTS expires_at timestamp;
ALTER TABLE licenses DROP CONSTRAINT IF EXISTS licenses_kind_check;
ALTER TABLE licenses ADD CONSTRAINT licenses_kind_check CHECK (kind IN ('paid', 'trial'));
-- Backstop anti-carrera: una sola licencia de prueba por máquina, para siempre.
CREATE UNIQUE INDEX IF NOT EXISTS uq_license_trial_machine ON licenses (machine_id) WHERE kind = 'trial';
