# Deployment de StockFlow Desktop

Esta guía cubre cómo empaquetar y distribuir la aplicación.

## Builds locales (sin firmar)

Para probar el instalador en tu propia máquina:

```bash
pnpm install
pnpm --filter @stockflow/desktop run generate:icons # PNG/ICNS/ICO desde icon.svg
pnpm --filter @stockflow/desktop run build          # web + electron
pnpm --filter @stockflow/desktop run build:mac      # .dmg + .zip en release/
pnpm --filter @stockflow/desktop run build:win      # .exe (NSIS) — requiere Windows
pnpm --filter @stockflow/desktop run build:linux    # .AppImage
```

Los scripts `build:*` corren vía `scripts/package.mjs`, un wrapper que sortea
el bucle de symlinks workspace de pnpm que rompe a `app-builder`. Genera
ambos arquitecturas (x64 + arm64) en macOS. Después del build, los binarios
nativos (`better-sqlite3`, `usb`, `serialport`) quedan recompilados para la
ABI de Electron; para volver a correr `test:ipc` con Node, ejecutá:

```bash
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
node-gyp rebuild --release
```

Los instaladores generados quedan en `apps/desktop/release/`.

> Los builds sin firmar funcionan localmente pero macOS muestra "no se puede
> abrir porque proviene de un desarrollador no identificado". En Windows
> SmartScreen muestra una advertencia equivalente. Para distribución pública
> hay que firmar (ver más abajo).

## Íconos y assets

Ver [`apps/desktop/build/README.md`](../apps/desktop/build/README.md) para
generar `icon.png`, `icon.icns`, `icon.ico` y `dmg-background.png` a partir
del SVG master.

## Firma de código

### macOS

Requiere cuenta Apple Developer (USD 99/año):

1. En App Store Connect crear un **Developer ID Application** certificate.
2. Exportar a `.p12` con clave.
3. Setear en CI:

   - `CSC_LINK`: ruta al `.p12` o `base64` del archivo.
   - `CSC_KEY_PASSWORD`: clave del `.p12`.
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: para
     notarizar (`notarize: true` ya está implícito con hardened runtime).

### Windows

Hace falta certificado EV Code Signing (USD 300–500/año, SSL.com,
DigiCert, Sectigo). Variables CI:

- `CSC_LINK`: `.pfx` o `base64` del cert.
- `CSC_KEY_PASSWORD`: clave del cert.

Para Authenticode estándar (no EV) el SmartScreen tarda en "calentar"
reputación; EV gana confianza inmediata.

## GitHub Releases

`apps/desktop/electron-builder.yml` ya declara `publish.provider: github`.

1. Crear repo privado `stockflow-ar/stockflow-desktop`.
2. Generar un PAT con scope `repo` y guardarlo como `GH_TOKEN`.
3. Tagear y pushear:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. El workflow `.github/workflows/release.yml` se dispara, builda en
   `macos-latest` + `windows-latest` y publica los artefactos al release
   draft asociado al tag.

## Release manual local

```bash
GH_TOKEN=ghp_xxx tsx apps/desktop/scripts/release.ts publish
```

Genera/actualiza `CHANGELOG.md`, crea tag y empuja a GitHub.

## Auto-update en producción

`electron-updater` se activa SÓLO cuando `app.isPackaged === true` y
`NODE_ENV !== 'development'`. Verifica al iniciar (5 s después de ready) y
cada 4 horas. Persiste el toggle en `{userData}/updater.json`.

El cliente desktop consulta los assets del último release del repo configurado
en `publish` y descarga el delta automáticamente. El usuario recibe un toast
"Hay una nueva versión, reiniciá para instalarla" cuando termina la descarga.
