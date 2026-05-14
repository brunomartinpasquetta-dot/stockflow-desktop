# Proceso de Release de StockFlow

## Requisitos previos

- `GH_TOKEN` configurado en `~/.zshrc` como variable de entorno (`export GH_TOKEN=ghp_...`).
- SSH key vinculada a GitHub (`ssh -T git@github.com` debe responder con el usuario).
- Acceso al repo `brunomartinpasquetta-dot/stockflow-desktop`.
- Node 20+, pnpm 9+, macOS para build local de `.dmg`.

## Publicar versión nueva

1. Hacer los cambios de código + commit normal.

2. Bumpar versión en `apps/desktop/package.json`:
   - **patch** (0.1.0 → 0.1.1): fixes.
   - **minor** (0.1.0 → 0.2.0): features nuevas.
   - **major** (0.1.0 → 1.0.0): cambios grandes / breaking.

3. Commitear el bump:
   ```bash
   git add apps/desktop/package.json
   git commit -m "chore: bump version to vX.Y.Z"
   ```

4. Crear tag y pushear:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```

5. Build y publicar:
   ```bash
   pnpm --filter @stockflow/desktop run publish:mac
   ```

   - Genera `.dmg arm64` + `.dmg x64` + `.zip arm64` + `.zip x64` + `latest-mac.yml` + blockmaps.
   - Sube todo al release `vX.Y.Z` en GitHub (lo crea como **draft** si no existe).

6. Verificar en GitHub Releases que aparece la versión:
   `https://github.com/brunomartinpasquetta-dot/stockflow-desktop/releases`

7. **Importante**: editar el draft de release en GitHub, agregar notas de cambios visibles al usuario y publicar (botón "Publish release"). Hasta que no lo publiques, los clientes NO reciben el update.

## Qué pasa después

- Los clientes con StockFlow abierto detectan el update en background (cada 4 horas + al iniciar).
- Se descarga automáticamente.
- Se muestra dialog "¿Reiniciar para actualizar?".
- Cliente acepta → la app se reinstala sola.

## Si algo sale mal

- Borrar el release problemático desde GitHub (no el tag del repo).
- Los clientes que NO descargaron aún quedan en versión anterior.
- Los que sí actualizaron pueden reinstalar manualmente desde el `.dmg` de la versión estable.

## Rollback rápido

```bash
# Si una versión publicada tiene un bug crítico:
# 1. En GitHub, borrar el release vX.Y.Z (NO borrar el tag)
# 2. Crear release patch con el fix:
#    Editar package.json: vX.Y.Z → vX.Y.(Z+1)
#    Aplicar fix + commit
git tag vX.Y.(Z+1)
git push origin main --tags
pnpm --filter @stockflow/desktop run publish:mac
```

## Notas técnicas

- El script `scripts/package.mjs` envuelve `electron-builder` para sortear el bucle de symlinks workspace de pnpm. Después del build, `better-sqlite3` queda recompilado para Electron ABI; si después querés correr smoke tests con tsx, rebuildea para Node:
  ```bash
  cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
  node-gyp rebuild --release
  ```
- Los íconos binarios (`icon.png`, `icon.icns`, `icon.ico`, `dmg-background.png`) NO están en git — se regeneran del SVG con `pnpm --filter @stockflow/desktop run generate:icons` (corre automático si los archivos no existen al hacer `build:mac`, salvo que invoques manualmente).
- Sin firma Apple Developer: macOS Gatekeeper exigirá "Abrir de todos modos" al primer arranque. Para producción seria, agregá `CSC_LINK` + `CSC_KEY_PASSWORD` antes de `publish:mac`.
