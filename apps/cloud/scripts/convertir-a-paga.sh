#!/usr/bin/env bash
#
# convertir-a-paga.sh — Convierte una licencia de PRUEBA GRATIS en licencia
# PAGA definitiva, conservando la MISMA clave y la misma máquina vinculada.
#
# Qué hace (en una transacción):
#   licenses:  kind='trial' → 'paid',  expires_at → NULL
#   tenants:   opcionalmente completa los datos reales del cliente (la prueba
#              nace con email sintético trial-...@trial.stockflow.local)
#
# La app del cliente se desbloquea SOLA en el próximo contacto con el cloud
# (heartbeat o arranque) — no hay que pedirle que haga nada.
#
# Uso:
#   ./convertir-a-paga.sh SF-XXXX-XXXX-XXXX-XXXX
#   ./convertir-a-paga.sh SF-XXXX-XXXX-XXXX-XXXX \
#       -c "Ferretería del Centro" -n "Juan Pérez" -e juan@gmail.com
#
# Requisitos: acceso SSH al VPS (llave ~/.ssh/id_ed25519 autorizada).
# Override del host: STOCKFLOW_VPS=usuario@host ./convertir-a-paga.sh ...
set -euo pipefail

VPS="${STOCKFLOW_VPS:-root@187.127.20.131}"
DB="stockflow_cloud"

CLAVE="${1:-}"
if [ -z "$CLAVE" ]; then
  echo "Uso: $0 SF-XXXX-XXXX-XXXX-XXXX [-c empresa] [-n titular] [-e email]" >&2
  exit 1
fi
shift

EMPRESA="" TITULAR="" EMAIL=""
while getopts "c:n:e:" opt; do
  case "$opt" in
    c) EMPRESA="$OPTARG" ;;
    n) TITULAR="$OPTARG" ;;
    e) EMAIL="$OPTARG" ;;
    *) exit 1 ;;
  esac
done

esc() { printf '%s' "$1" | sed "s/'/''/g"; }
CLAVE_ESC=$(esc "$CLAVE")

echo "── Licencia actual:"
ESTADO=$(ssh "$VPS" "sudo -u postgres psql $DB -t -A -F' | ' -c \"
  SELECT l.license_key, l.kind, l.status, to_char(l.expires_at,'YYYY-MM-DD') AS vence,
         t.company_name, t.full_name, t.email
  FROM licenses l JOIN tenants t ON t.id = l.tenant_id
  WHERE l.license_key = '$CLAVE_ESC';\"")
if [ -z "$ESTADO" ]; then
  echo "✗ No existe ninguna licencia con la clave $CLAVE" >&2
  exit 1
fi
echo "   $ESTADO"

KIND=$(printf '%s' "$ESTADO" | cut -d'|' -f2 | tr -d ' ')
if [ "$KIND" = "paid" ]; then
  echo "✗ Esa licencia YA es paga — nada para hacer." >&2
  exit 1
fi

echo
read -r -p "¿Convertir a PAGA definitiva (misma clave, misma PC)? Escribí SI: " CONF
[ "$CONF" = "SI" ] || { echo "Cancelado."; exit 1; }

SET_TENANT=""
[ -n "$EMPRESA" ] && SET_TENANT="$SET_TENANT, company_name='$(esc "$EMPRESA")'"
[ -n "$TITULAR" ] && SET_TENANT="$SET_TENANT, full_name='$(esc "$TITULAR")'"
[ -n "$EMAIL" ]   && SET_TENANT="$SET_TENANT, email='$(esc "$EMAIL")'"

ssh "$VPS" "sudo -u postgres psql $DB -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
UPDATE licenses SET kind='paid', expires_at=NULL
 WHERE license_key='$CLAVE_ESC' AND kind='trial';
$( [ -n "$SET_TENANT" ] && echo "UPDATE tenants SET updated_at=now()${SET_TENANT}
 WHERE id=(SELECT tenant_id FROM licenses WHERE license_key='$CLAVE_ESC');" )
COMMIT;
SQL"

echo
echo "── Verificación:"
ssh "$VPS" "sudo -u postgres psql $DB -t -A -F' | ' -c \"
  SELECT l.license_key, l.kind, l.status, COALESCE(to_char(l.expires_at,'YYYY-MM-DD'),'sin vencimiento'),
         t.company_name, t.full_name, t.email
  FROM licenses l JOIN tenants t ON t.id = l.tenant_id
  WHERE l.license_key = '$CLAVE_ESC';\""
echo "✅ Convertida. La app del cliente se desbloquea sola en el próximo contacto (heartbeat o al abrir StockFlow)."
