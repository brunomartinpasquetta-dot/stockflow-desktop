# StockFlow — Contexto del proyecto

> Documento de estado. Última actualización: 2026-05-17.

## Qué es

Sistema de gestión comercial para comercios argentinos (kioscos, despensas, ferreterías, polirubros). App de escritorio Electron + API cloud de licenciamiento.

## Stack

| Capa | Tecnología |
|---|---|
| Desktop | Electron 30 + React 19 + TypeScript + Vite |
| UI | Tailwind v3 + shadcn/ui + lucide-react + sonner |
| DB local | SQLite (better-sqlite3) + Drizzle ORM |
| Cloud | Fastify 4 + Postgres + `@fastify/jwt` (RS256) |
| Pagos | MercadoPago Preapproval (suscripciones) + QR Atendido (cobros) |
| Gráficos | recharts |
| Packaging | electron-builder + electron-updater |

## Monorepo (pnpm)

```
apps/desktop   — app Electron (main process + renderer React)
apps/cloud     — API Fastify (licenciamiento + webhooks MP)
packages/shared — tipos + utils (currency, vat) compartidos
packages/db    — schema Drizzle + repositorios + migraciones
packages/core  — servicios de dominio + auth/permisos
```

## Estado de releases

- **Versión actual publicada:** v0.1.13
- **Repo GitHub:** `github.com/brunomartinpasquetta-dot/stockflow-desktop` (público)
- **Releases:** auto-update vía GitHub Releases. ⚠️ El auto-update macOS **no aplica** sin firma de Apple Developer — hay que instalar el `.dmg` manualmente. v0.1.13 agregó un banner que avisa cuando hay versión nueva.
- **Build:** `pnpm --filter @stockflow/desktop run build:mac` (vía `scripts/package.mjs`, wrapper que sortea el bucle de symlinks de pnpm).

## Funcionalidades implementadas

- **PDV (Ventas)**: carrito, código de barras, multi-lista de precios, mono-medio de pago + pago mixto, MercadoPago QR, venta a cuenta corriente, peso por balanza.
- **Compras**: ídem con proveedores, actualización de costos.
- **Caja diaria**: apertura/cierre con arqueo, movimientos manuales, historial.
- **Caja General**: saldo histórico global con ingresos/egresos manuales.
- **Artículos**: ABM master-detail, imagen, Lista 1/2/3, stock mín/ideal, % utilidad.
- **Clientes / Proveedores / Familias / Usuarios / Medios de pago**: ABM.
- **Cuentas corrientes** clientes y proveedores.
- **Contabilidad**: Activos/Ventas/CMV/Resultado Bruto + Libro IVA Ventas/Compras.
- **Consultas**: Historial Ventas/Compras/Cajas, Generador de Compras, Inventario, Ventas por Vendedor.
- **Estadísticas**: dashboard con 6 tabs (productos, clientes, proveedores, pagos, tiempo).
- **Actualización masiva de precios** con filtros + preview + rollback + historial.
- **Hardware**: impresora térmica (window.print + CSS @media print), balanza serial, cajón monedero.
- **Backup** automático + Importación Excel.
- **Multi-caja LAN**: server + cliente sobre red local.
- **Licenciamiento**: cloud + MercadoPago Preapproval + activación por máquina. Master key del owner: `SF-BRUN-OWNR-MSTR-2026`.
- **UI**: layout MDI estilo Windows (menubar 8 grupos + toolbar 10 botones + ventanas internas), command palette Cmd+K.

## Migraciones DB local

`0000_steady_fallen_one` · `0001_payment_methods` · `0002_price_mode` · `0003_supplier_accounts` · `0005_price_updates` · `0006_mp_qr` · `0007_caja_general`.
(`0004` se omitió: las columnas ya existían en el schema base.)

## Impresión — cómo funciona

Patrón canónico de SINATRA (validado en producción): `window.print()` + CSS `@media print` aislado a `#print-area`. NADA de bytes ESC/POS crudos.
- `#print-area` es hijo directo de `<body>` en `index.html`.
- CSS con `body.printing-58 / printing-80 / printing-a4` controla el ancho.
- `printService.ts` monta el ticket con `createRoot`, espera 2 `requestAnimationFrame`, llama `window.print()`.
- v0.1.13: modo silencioso opcional vía `webContents.print({ silent:true })` en BrowserWindow oculto.
- Requiere que la impresora esté instalada en el SO con un driver que rasterice (no "Generic Text").

## Pendiente CRÍTICO — bugs de saldos (audit 2026-05-17)

Ver `docs/AUDIT_SALDOS_2026_05_17.md`. Cliente reportó diferencias grandes de importes. 2 BLOCKER + 5 HIGH:

- **BUG-S01 (BLOCKER)**: `transferFromDaily` suma a Caja General pero no descuenta de la caja diaria → dinero duplicado.
- **BUG-S02 (BLOCKER)**: `getFinancialSummary.cashValue` no incluye el balance de Caja General → activos subreportados.
- **BUG-S03 (HIGH)**: AR/AP de ventas/compras a cuenta se crean fuera de la transacción del INSERT.
- **BUG-S04/S05 (HIGH)**: anulaciones con split lumpean reversos bajo un solo `paymentMethodId`.
- **BUG-S06 (HIGH)**: `voidSale` no contempla movimientos legacy con `paymentMethodId NULL`.
- **BUG-S07 (HIGH)**: AccountingService filtra efectivo por `type==='cash'` en vez de `isPhysicalCash`.

**Próximo paso inmediato: fixear estos 7 bugs en v0.1.14.**

## Otros pendientes / roadmap

- **FASE 4**: auditoría con seeder de volumen (300+ ventas, 50+ compras, 30 cajas).
- **P12 — ARCA AFIP**: factura electrónica con CAE (WSAA + WSFE) para Responsables Inscriptos.
- **Firma de código**: Apple Developer (USD 99/año) → arregla el auto-update de raíz. Windows EV cert (USD 300+).
- **Cloud webhook MP + SSE**: `MpQrService.handleWebhook` está listo pero falta el endpoint Fastify `POST /api/mp/webhook/:tenantId` + SSE desktop. Hoy el cobro QR funciona sólo por polling 3s.
- **Compras**: integración del modal de peso para artículos `soldByWeight`.

## Cómo correr en dev

```bash
pnpm install
pnpm --filter @stockflow/desktop electron:dev   # NODE_ENV=development → bypass de licencia
```

## Tests

```bash
pnpm -r run type-check
pnpm --filter @stockflow/desktop lint
pnpm --filter @stockflow/core test:smoke
pnpm --filter @stockflow/db test:smoke
pnpm --filter @stockflow/desktop test:ipc      # requiere better-sqlite3 ABI Node
```

> Nota: tras `build:mac`, `better-sqlite3` queda en ABI de Electron. Para correr smoke tests con Node hay que rebuildearlo (`node-gyp rebuild` en su carpeta).

## Documentos del repo

- `docs/AUDIT_SALDOS_2026_05_17.md` — auditoría de bugs de saldos (PRIORIDAD).
- `docs/AUDIT_E2E_2026_05_14.md` — auditoría e2e estática.
- `docs/RELEASE_PROCESS.md` — cómo publicar versiones.
- `docs/DEPLOYMENT.md` — packaging y firma.
- `docs/LAN_SETUP.md` — configuración multi-caja.
- `docs/MERCADOPAGO_SETUP.md` — integración MP QR.
- `BACKLOG.md` — pendientes generales.
