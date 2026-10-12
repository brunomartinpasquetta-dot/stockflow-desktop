#!/bin/bash
# Métricas del embudo de StockFlow, SIN datos de clientes (sólo conteos), para la
# sesión de marketing: pruebas gratis creadas, convertidas, activas, vencidas,
# clientes pagos activos y bajas. Lee la base del cloud por SSH (sólo lectura).
#
#   apps/cloud/scripts/metricas-funnel.sh            → imprime la fila de hoy
#   apps/cloud/scripts/metricas-funnel.sh --csv ARCH → además la agrega al CSV
#
# Definiciones (tablas tenants/licenses del cloud):
#  - prueba = tenant con email sintético @trial.stockflow.local (así nace la prueba
#    gratis autoservicio); convertida = esa misma licencia hoy kind='paid'.
#  - cliente pago activo = licencia paid, status active, con latido en 14 días.
#  - baja = licencia revoked o suspended.
# Los totales son acumulados; la variación semanal sale de comparar filas del CSV.
set -euo pipefail
VPS="${STOCKFLOW_VPS:-vps-stockflow}"
SQL="
WITH t AS (SELECT id, created_at, (email LIKE '%@trial.stockflow.local') AS es_prueba FROM tenants),
     l AS (SELECT * FROM licenses)
SELECT
  to_char(now() AT TIME ZONE 'America/Argentina/Cordoba','YYYY-MM-DD') AS fecha,
  (SELECT count(*) FROM t WHERE es_prueba AND created_at >= now() - interval '7 days')  AS pruebas_creadas_7d,
  (SELECT count(*) FROM t WHERE es_prueba AND created_at >= now() - interval '30 days') AS pruebas_creadas_30d,
  (SELECT count(*) FROM t WHERE es_prueba)                                               AS pruebas_creadas_total,
  (SELECT count(*) FROM l JOIN t ON t.id=l.tenant_id WHERE t.es_prueba AND l.kind='paid') AS pruebas_convertidas_total,
  (SELECT count(*) FROM l WHERE kind='trial' AND status='active' AND (expires_at IS NULL OR expires_at > now())) AS pruebas_activas,
  (SELECT count(*) FROM l WHERE kind='trial' AND expires_at < now())                     AS pruebas_vencidas_sin_convertir,
  (SELECT count(*) FROM l WHERE kind='paid' AND status='active' AND last_heartbeat >= now() - interval '14 days') AS clientes_pagos_activos,
  (SELECT count(*) FROM l WHERE kind='paid' AND status='active')                         AS licencias_pagas_total,
  (SELECT count(*) FROM l WHERE status IN ('revoked','suspended'))                       AS bajas_o_suspendidas;
"
FILA=$(ssh -n -o ConnectTimeout=20 -o BatchMode=yes "$VPS" "sudo -u postgres psql stockflow_cloud -At -F ',' -c \"$SQL\"")
CABECERA="fecha,pruebas_creadas_7d,pruebas_creadas_30d,pruebas_creadas_total,pruebas_convertidas_total,pruebas_activas,pruebas_vencidas_sin_convertir,clientes_pagos_activos,licencias_pagas_total,bajas_o_suspendidas"
echo "$CABECERA"; echo "$FILA"
if [ "${1:-}" = "--csv" ] && [ -n "${2:-}" ]; then
  mkdir -p "$(dirname "$2")"
  [ -f "$2" ] || echo "$CABECERA" > "$2"
  echo "$FILA" >> "$2"
  echo "→ agregada a $2"
fi
