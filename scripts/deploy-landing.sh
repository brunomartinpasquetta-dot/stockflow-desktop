#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy de la landing de StockFlow → bpsgsistemas.com
#
#   ./scripts/deploy-landing.sh
#
# Regenera la landing y sube TODO lo que el build emite hoy:
#   index3.html (renombrado a index.html en el docroot) + js/ + assets/ +
#   og.jpg + favicon.png  →  /var/www/stockflow-landing/
#
# El README viejo documentaba un scp de index.html suelto: ese archivo es la
# versión SELF-CONTAINED de julio, SIN tracking — subirlo pisa la landing con
# la vieja. Este script existe para que eso no vuelva a pasar.
#
# NO toca /var/www/stockflow-landing/dl/ (ahí viven los instaladores) ni nada
# fuera del docroot de la landing. Backup del index anterior con la convención
# ya usada en el VPS: index.html.bak-YYYYMMDD-HHMM.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VPS="${STOCKFLOW_VPS:-root@187.127.20.131}"
DOCROOT="/var/www/stockflow-landing"
AQUI="$(cd "$(dirname "$0")/.." && pwd)"
LANDING="$AQUI/marketing/landing"

echo "── 1/4 Regenerando la landing (build_landing.py)…"
(cd "$LANDING" && python3 build_landing.py)

echo "── 2/4 Backup del index remoto…"
ssh "$VPS" "cp $DOCROOT/index.html $DOCROOT/index.html.bak-\$(date +%Y%m%d-%H%M) 2>/dev/null || true"

echo "── 3/4 Subiendo archivos…"
scp -q "$LANDING/index3.html" "$VPS:$DOCROOT/index.html"
rsync -a "$LANDING/js/"     "$VPS:$DOCROOT/js/"
rsync -a "$LANDING/assets/" "$VPS:$DOCROOT/assets/"
scp -q "$LANDING/og.jpg" "$LANDING/favicon.png" "$VPS:$DOCROOT/"

echo "── 4/4 Verificando contra el sitio publicado…"
LM=$(curl -sI https://bpsgsistemas.com/ | grep -i '^last-modified' || true)
PIXEL=$(curl -s https://bpsgsistemas.com/ | grep -c '1363051382693261' || true)
JS=$(curl -s -o /dev/null -w '%{http_code}' https://bpsgsistemas.com/js/tracking.js)
echo "   $LM"
echo "   píxel en el HTML servido: $PIXEL aparición(es)"
echo "   js/tracking.js → HTTP $JS"
if [ "$PIXEL" -ge 1 ] && [ "$JS" = "200" ]; then
  echo "✅ Landing publicada con tracking."
else
  echo "✗ VERIFICACIÓN FALLÓ — revisar antes de dar por bueno el deploy." >&2
  exit 1
fi
