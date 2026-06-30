#!/usr/bin/env bash
#
# licencias.sh — Lista los clientes (tenants) de StockFlow Cloud con su clave de
# activación, estado de cuenta/licencia y máquina vinculada.
#
# Es una consulta de SOLO LECTURA contra la base de producción (no escribe nada).
# Sirve para tener a mano la clave de un cliente cuando hay que (re)activar su PC.
#
# Uso:
#   ./licencias.sh            # lista TODOS los clientes
#   ./licencias.sh coronda    # filtra por empresa / titular / email / clave
#
# Requisitos: acceso SSH al VPS (llave ~/.ssh/id_ed25519 autorizada como root).
# Podés override del host con STOCKFLOW_VPS=usuario@host ./licencias.sh
set -euo pipefail

VPS="${STOCKFLOW_VPS:-root@187.127.20.131}"
DB="stockflow_cloud"
FILTER="${1:-}"

if [ -n "$FILTER" ]; then
  ESC=$(printf '%s' "$FILTER" | sed "s/'/''/g")   # escapa comillas simples
  WHERE="WHERE t.company_name ILIKE '%${ESC}%' OR t.full_name ILIKE '%${ESC}%' OR t.email ILIKE '%${ESC}%' OR l.license_key ILIKE '%${ESC}%'"
else
  WHERE=""
fi

SQL="SELECT t.company_name AS empresa,
            t.full_name     AS titular,
            t.email,
            t.status        AS cuenta,
            t.plan,
            l.license_key    AS clave,
            l.status         AS licencia,
            CASE WHEN l.machine_id IS NULL THEN '(libre)' ELSE left(l.machine_id, 10) END AS maquina,
            to_char(l.last_heartbeat, 'YYYY-MM-DD HH24:MI') AS ultimo_hb
     FROM tenants t
     LEFT JOIN licenses l ON l.tenant_id = t.id
     ${WHERE}
     ORDER BY t.created_at;"

ssh -o ConnectTimeout=12 "$VPS" "sudo -u postgres psql ${DB} -P pager=off -x -c \"${SQL}\""
