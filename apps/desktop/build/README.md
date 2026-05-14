# Build resources

Assets que consume `electron-builder`.

## Archivos en repo

- `icon.svg` — master del logo (1024×1024, "S" blanca sobre #1e40af).
- `dmg-background.svg` — fondo del DMG (540×380).
- `entitlements.mac.plist` — entitlements para hardened runtime en macOS.

## Archivos generados (no se commitean)

- `icon.png`, `icon.icns`, `icon.ico`, `dmg-background.png`

Se regeneran automáticamente con:

```bash
pnpm --filter @stockflow/desktop run generate:icons
```

El script (`scripts/generate-icons.mjs`) usa `sharp` + `png2icons` (puro Node, sin
dependencias del SO). Si cambiás `icon.svg`, corré el comando otra vez.

## Empaquetado local

```bash
# 1) Generar íconos (solo la primera vez o tras cambiar el SVG)
pnpm --filter @stockflow/desktop run generate:icons

# 2) Build del bundle JS
pnpm --filter @stockflow/desktop run build

# 3) Empaquetar para macOS (.dmg + .zip, sin firma)
pnpm --filter @stockflow/desktop run build:mac

# Otras opciones:
pnpm --filter @stockflow/desktop run build:linux   # AppImage
pnpm --filter @stockflow/desktop run build:win     # NSIS (.exe) — requiere Windows/wine
pnpm --filter @stockflow/desktop run package:dry   # sólo .app sin .dmg
```

Los artefactos quedan en `apps/desktop/release/`.

> **Nota:** `build:mac` corre vía `scripts/package.mjs`, un wrapper que sortea
> el bucle de symlinks workspace de pnpm desplazando temporalmente
> `packages/{shared,db}/node_modules/@stockflow` y restaurándolos al final.
> Los workspace packages están bundleados en `dist-electron/main.mjs`, así que
> no se usan en runtime; sólo molestan al collector de `app-builder`.

## Firma y notarización (producción)

Builds locales se firman con `identity: null` (sin firma — Gatekeeper exigirá
"Abrir de todos modos" la primera vez).

Para producción configurá:

- macOS: `CSC_LINK` (cert `.p12` base64) + `CSC_KEY_PASSWORD` + cuenta Apple
  Developer (USD 99/año) para notarizar.
- Windows: `CSC_LINK` con cert EV (USD 300–500/año, SSL.com / DigiCert /
  Sectigo).
