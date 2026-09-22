#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# BAJA DE ACCESO REMOTO DE UN CLIENTE
#
#   ./baja-cliente.sh paranacito
#
# Borra SU túnel y SU dirección. Los demás clientes no se enteran: cada uno
# tiene su propia credencial. No hace falta entrar a la PC del comercio — al
# quedarse sin túnel, su acceso deja de funcionar en el acto.
# ---------------------------------------------------------------------------
set -euo pipefail

DOMINIO="${STOCKFLOW_DOMINIO:-mistockflow.com}"
CLOUDFLARED="${CLOUDFLARED_BIN:-$HOME/bin/cloudflared}"

cliente="${1:-}"
[[ -z "$cliente" ]] && { echo "Uso: $0 <cliente>" >&2; exit 1; }
nombre="stockflow-$cliente"

echo "Se va a dar de baja el acceso remoto de '$cliente' ($cliente.$DOMINIO)."
read -r -p "Escribí el nombre del cliente para confirmar: " confirma
[[ "$confirma" == "$cliente" ]] || { echo "Cancelado."; exit 1; }

"$CLOUDFLARED" tunnel cleanup "$nombre" >/dev/null 2>&1 || true
"$CLOUDFLARED" tunnel delete -f "$nombre"
echo "Listo: '$cliente' ya no tiene acceso remoto."
echo "La dirección $cliente.$DOMINIO queda apuntando a un túnel inexistente;"
echo "se puede borrar el registro DNS desde el panel de Cloudflare."
