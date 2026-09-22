#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ALTA DE ACCESO REMOTO PARA UN CLIENTE
#
#   ./alta-cliente.sh paranacito
#
# Crea el túnel de ese comercio, le reserva su dirección (<cliente>.<dominio>)
# y deja los tres datos que hay que cargar UNA vez en su PC, en
# Configuración → Red → Acceso remoto:
#
#   1. la dirección asignada
#   2. el identificador del túnel
#   3. la credencial (el contenido del archivo .json)
#
# Cada comercio tiene SU credencial: darle de baja a uno (./baja-cliente.sh)
# no toca a los demás. La credencial no viaja nunca dentro del instalador.
#
# Requisitos: cloudflared instalado y autorizado una vez con
# `cloudflared tunnel login` (queda ~/.cloudflared/cert.pem).
# ---------------------------------------------------------------------------
set -euo pipefail

DOMINIO="${STOCKFLOW_DOMINIO:-mistockflow.com}"
CLOUDFLARED="${CLOUDFLARED_BIN:-$HOME/bin/cloudflared}"

cliente="${1:-}"
if [[ -z "$cliente" ]]; then
  echo "Uso: $0 <cliente>     (ejemplo: $0 paranacito)" >&2
  exit 1
fi
if [[ ! "$cliente" =~ ^[a-z0-9-]+$ ]]; then
  echo "El nombre del cliente va en minúsculas, sin espacios ni acentos (ej: leo-citzia)." >&2
  exit 1
fi
if [[ ! -x "$CLOUDFLARED" ]]; then
  echo "No encuentro cloudflared en $CLOUDFLARED (se puede indicar con CLOUDFLARED_BIN)." >&2
  exit 1
fi
if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
  echo "Falta autorizar la cuenta una vez: $CLOUDFLARED tunnel login" >&2
  exit 1
fi

hostname="$cliente.$DOMINIO"
nombre="stockflow-$cliente"

echo "→ Creando el túnel $nombre"
"$CLOUDFLARED" tunnel create "$nombre" >/dev/null 2>&1 || {
  echo "  (ya existía: se reutiliza)"
}
id="$("$CLOUDFLARED" tunnel list --output json | python3 -c "
import json,sys
for t in json.load(sys.stdin):
    if t.get('name') == '$nombre':
        print(t['id']); break
")"
if [[ -z "$id" ]]; then
  echo "No se pudo obtener el identificador del túnel." >&2
  exit 1
fi

echo "→ Reservando la dirección $hostname"
"$CLOUDFLARED" tunnel route dns --overwrite-dns "$nombre" "$hostname" >/dev/null

credencial="$HOME/.cloudflared/$id.json"
if [[ ! -f "$credencial" ]]; then
  echo "No encuentro la credencial en $credencial" >&2
  exit 1
fi

cat <<FIN

=========================================================================
  ACCESO REMOTO LISTO — $cliente
=========================================================================

  Cargar estos tres datos en la PC del comercio, una sola vez, en
  Configuración → Red → Acceso remoto → Configurar:

  Dirección asignada : $hostname
  Identificador      : $id
  Credencial         : el contenido del archivo
                       $credencial

  Después, prender el interruptor "Acceso remoto". La dirección queda
  https://$hostname

  La credencial se manda por un medio privado y NO se guarda en el repo
  ni viaja en el instalador.

  Para dar de baja este acceso: ./baja-cliente.sh $cliente
=========================================================================
FIN
