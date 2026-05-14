# StockFlow

Sistema de gestión comercial para comercios argentinos. Pensado para kioscos, despensas, ferreterías y polirubros.

## Características

- Punto de venta (PDV) con código de barras
- Gestión de stock multi-lista de precios
- Caja diaria + Historial de cajas
- Cuentas corrientes (clientes y proveedores)
- Cobro con MercadoPago QR integrado
- Contabilidad básica + Libro IVA Ventas/Compras
- Backup automático
- Multi-caja vía red local (LAN)
- Auto-update vía GitHub Releases

## Stack

- Electron 30 + React 19 + TypeScript
- SQLite local + Drizzle ORM
- Fastify cloud (licensing + MercadoPago Preapproval)
- electron-builder + electron-updater

## Instalación (desarrollo)

```bash
pnpm install
pnpm --filter @stockflow/desktop electron:dev
```

## Build de producción

```bash
pnpm --filter @stockflow/desktop run build
pnpm --filter @stockflow/desktop run build:mac
```

## Publicar nueva versión

```bash
# 1. Bump version en apps/desktop/package.json (ej. 0.1.0 → 0.1.1)
# 2. Commit + tag + push
git tag v0.1.1
git push origin main --tags
# 3. Build y publicar
pnpm --filter @stockflow/desktop run publish:mac
```

Los clientes con StockFlow instalado reciben el update automáticamente.

## Licencia

Propietario. Todos los derechos reservados.
