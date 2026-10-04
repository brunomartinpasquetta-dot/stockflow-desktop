#!/bin/sh
# Corre el lector PaddleOCR de la app (apps/desktop/native/ocr-paddle/leer.mjs, con el
# Electron del repo como Node) sobre las 8 fotos de muestras/ con una variante de
# opciones, guarda los JSON en salida-paddle/<variante>/ y el tiempo de pared por hoja,
# y después los evalúa con el MISMO pipeline de la app (evaluar.mts con el electron del repo).
#
#   ./medir-paddle.sh <variante> [opciones de leer.mjs...]
#   ./medir-paddle.sh v4det-latin5 --lado 2000
#   ./medir-paddle.sh mac            → sólo evalúa salida-paddle/mac (JSON de vision-ocr)
set -e
AQUI=$(cd "$(dirname "$0")" && pwd)
RAIZ=$(cd "$AQUI/../.." && pwd)
VARIANTE=$1; shift || true
[ -n "$VARIANTE" ] || { echo "uso: medir-paddle.sh <variante> [opciones]" >&2; exit 2; }
DIR="$AQUI/salida-paddle/$VARIANTE"
mkdir -p "$DIR"
ELECTRON="$RAIZ/apps/desktop/node_modules/.bin/electron"
LEER="$RAIZ/apps/desktop/native/ocr-paddle/leer.mjs"

if [ "$VARIANTE" != "mac" ]; then
  : > "$DIR/tiempos.txt"
  echo "opciones: $*" > "$DIR/opciones.txt"
  for f in alvinovino bernardi bernardi-2 roa vital-12 vital-13 vital-14 vital-15; do
    ini=$(python3 -c 'import time;print(time.time())')
    ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$LEER" "$AQUI/muestras/$f.jpg" --tiempos "$@" > "$DIR/$f.json" 2> "$DIR/$f.err"
    fin=$(python3 -c 'import time;print(time.time())')
    seg=$(python3 -c "print(round($fin-$ini,2))")
    detalle=$(tail -1 "$DIR/$f.err")
    echo "$f $seg s | $detalle" | tee -a "$DIR/tiempos.txt"
  done
fi

cd "$RAIZ/apps/desktop"
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/tsx/dist/cli.mjs "$AQUI/evaluar.mts" "$DIR" --detalle 2>&1
