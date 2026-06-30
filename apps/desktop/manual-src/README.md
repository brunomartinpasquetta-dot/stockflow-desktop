# Fuente del Manual de Usuario (PDF)

Acá vive la **fuente** del manual que la app abre con _Ayuda → Manual de usuario_.
El PDF final se bundlea en `apps/desktop/build/manual.pdf` (ver `extraResources`
en `electron-builder.yml`). Esta carpeta existe para que el manual **no se pierda**
y se pueda regenerar (antes el HTML no estaba versionado y hubo que rehacerlo).

## Archivos

- `build_manual.py` — generador. Lee `sections.json` + `shots/*.png` y emite un
  HTML autocontenido (imágenes embebidas en base64). Omite cualquier captura que
  no exista en `shots/`. Las capturas que SÍ existen se ordenan primero en cada
  sección (la portada de cada módulo es siempre una imagen real).
- `sections.json` — todo el contenido (11 módulos: overview, subsecciones con
  pasos/tips, y la lista de capturas con su epígrafe).
- `a4doc.html` — mock del **documento A4 formal** (presupuesto/ticket A4). Se
  renderiza aparte con Chrome headless para generar `shots/presupuestos-pdf.png`
  (replica `.doc-a4` de `src/index.css` + el componente `FormalDocA4.tsx`).
- `shots/` — capturas de pantalla usadas en el manual.

## Regenerar

```bash
cd apps/desktop/manual-src
LOGO=../src/assets/branding/logo-stacked.png
python3 build_manual.py sections.json manual.html <version> "$LOGO"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=../build/manual.pdf "file://$PWD/manual.html"
```

### Regenerar la captura del PDF A4 formal (si cambia `FormalDocA4`/`.doc-a4`)

```bash
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=880,760 --screenshot=shots/presupuestos-pdf.png "file://$PWD/a4doc.html"
```

## Capturas de la app en vivo

Se toman manejando la app instalada con AppleScript + `screencapture -R<bounds>`
(bounds de la ventana vía System Events) y clicks por CGEvent. No hay un script
único versionado; ver el historial de la sesión si hace falta reproducir el flujo.
