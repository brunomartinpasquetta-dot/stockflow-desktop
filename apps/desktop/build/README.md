# Build resources

Este directorio contiene los assets que consume `electron-builder`.

## Estado actual

- `icon.svg`: master de logo (1024×1024, S blanca sobre #1e40af).
- `dmg-background.svg`: fondo del DMG (540×380, con instrucción "Arrastrá StockFlow a Aplicaciones").
- `entitlements.mac.plist`: entitlements para hardened runtime en macOS.
- `icon.png` / `icon.icns` / `icon.ico`: **PENDIENTES** — generar a partir del SVG.

## Cómo generar los binarios

No se commitean los PNG/ICNS/ICO porque requieren herramientas nativas que
varían entre plataformas. Para regenerarlos:

```bash
# Necesitás: rsvg-convert (librsvg) + iconutil (macOS) + png-to-ico (npm)
brew install librsvg
npm i -g png-to-ico

cd apps/desktop/build

# 1) PNG base (1024)
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png

# 2) ICNS para macOS
mkdir -p icon.iconset
for size in 16 32 64 128 256 512 1024; do
  rsvg-convert -w $size -h $size icon.svg -o icon.iconset/icon_${size}x${size}.png
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset

# 3) ICO para Windows
rsvg-convert -w 256 -h 256 icon.svg -o icon-256.png
png-to-ico icon-256.png > icon.ico
rm icon-256.png

# 4) DMG background
rsvg-convert -w 540 -h 380 dmg-background.svg -o dmg-background.png
```

Si no podés generar estos assets en tu máquina de desarrollo, igual podés
correr `pnpm --filter @stockflow/desktop run build:web` y
`pnpm --filter @stockflow/desktop run build:electron` (sólo el bundle JS).
`electron-builder` los necesita únicamente para el paso final de empaquetado
(`build:mac` / `build:win` / `build:linux`).
