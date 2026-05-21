# StockFlow — Contexto del proyecto

> Documento de estado. Última actualización: 2026-05-21. Versión publicada: v0.1.21.

## Qué es

Sistema de gestión comercial de escritorio para comercios argentinos (kioscos,
despensas, ferreterías, polirubros). App Electron + API cloud de licenciamiento.

## Stack

- Desktop: Electron 30 + React 19 + TypeScript + Vite
- UI: Tailwind v3 + shadcn/ui + lucide-react + sonner + recharts
- DB local: SQLite (better-sqlite3) + Drizzle ORM
- Cloud: Fastify 4 + Postgres + @fastify/jwt RS256
- Pagos: MercadoPago Preapproval (suscripciones) + QR Atendido (cobros)
- Packaging: electron-builder + electron-updater (releases en GitHub)

## Monorepo (pnpm)

- apps/desktop — app Electron (main process + renderer React)
- apps/cloud — API Fastify (licenciamiento + webhooks MP)
- packages/shared — tipos + utils (currency, vat)
- packages/db — schema Drizzle + repositorios + migraciones
- packages/core — servicios de dominio + auth/permisos

## Releases

- Versión actual: v0.1.21.
- Repo: github.com/brunomartinpasquetta-dot/stockflow-desktop (público).
- Build: pnpm --filter @stockflow/desktop run build:mac (vía scripts/package.mjs).
- IMPORTANTE: el auto-update macOS NO aplica sin firma de Apple Developer
  (Squirrel.Mac la exige). Hay que instalar el .dmg manualmente cada release.
  v0.1.13+ trae un banner que avisa de versión nueva con link al .dmg.

## Funcionalidades

PDV, compras, caja diaria + Caja General, artículos (master-detail, imagen,
multi-lista de precios), clientes/proveedores/familias/usuarios, cuentas
corrientes, contabilidad + Libro IVA, estadísticas (dashboard recharts),
actualización masiva de precios, hardware (impresora/balanza/cajón), backup,
importación Excel, multi-caja LAN, command palette Cmd+K, MercadoPago QR.

## Ventanas (v0.1.17)

Ventanas nativas del SO: cada pantalla abre como BrowserWindow real (ruta
/embedded/:pageKey). La ventana principal tiene menubar + toolbar + welcome.
Sync entre ventanas vía refetchOnWindowFocus de TanStack Query.

## Impresión — estado y lección

Patrón: window.print() + CSS @media print sobre #print-area. NADA de ESC/POS
crudo ni webContents.print silencioso con pageSize custom (rompe drivers
térmicos genéricos → bytes basura infinitos). El window.print() abre el
diálogo del SO pero imprime confiable en cualquier impresora instalada.
La detección de impresoras usa lpstat con LANG=C (macOS en español).
El ticket de venta toma los datos del negocio de Configuración → Empresa.

## Migraciones DB local

0000_steady_fallen_one · 0001_payment_methods · 0002_price_mode ·
0003_supplier_accounts · 0005_price_updates · 0006_mp_qr · 0007_caja_general.

## Saldos — auditoría 2026-05-17 (fixeado en v0.1.14)

7 bugs de integridad contable resueltos (ver docs/AUDIT_SALDOS_2026_05_17.md):
- S01 BLOCKER: transferFromDaily duplicaba dinero — ahora descuenta de la caja diaria.
- S02 BLOCKER: getFinancialSummary.cashValue ahora incluye Caja General.
- S03: AR/AP de ventas/compras a cuenta dentro de la transacción del INSERT.
- S04/S05: anulaciones revierten cada medio de pago por separado.
- S06: voidSale maneja cash_movements legacy con paymentMethodId NULL.
- S07: efectivo físico filtrado por isPhysicalCash (no type==='cash').

## Pendientes / roadmap

- FIRMAR el .app con Apple Developer (USD 99/año) → arregla el auto-update.
- FASE 4: auditoría con seeder de volumen (300+ ventas).
- P12 — ARCA AFIP: factura electrónica con CAE (sólo Responsables Inscriptos).
- Cloud webhook MP + SSE: handleWebhook listo, falta endpoint Fastify.
- Master key del owner: SF-BRUN-OWNR-MSTR-2026 (licencia pro local sin cloud).

## Cómo correr en dev

  pnpm install
  pnpm --filter @stockflow/desktop electron:dev   (NODE_ENV=development bypassa licencia)

## Tests

  pnpm -r run type-check
  pnpm --filter @stockflow/desktop lint
  pnpm --filter @stockflow/core test:smoke
  pnpm --filter @stockflow/db test:smoke
  pnpm --filter @stockflow/desktop test:ipc   (requiere better-sqlite3 ABI Node)

Nota: tras build:mac, better-sqlite3 queda en ABI de Electron. Para correr
smoke tests con Node hay que rebuildearlo (node-gyp rebuild en su carpeta).

## Documentos del repo

- docs/AUDIT_SALDOS_2026_05_17.md — auditoría de bugs de saldos.
- docs/AUDIT_E2E_2026_05_14.md — auditoría e2e estática.
- docs/RELEASE_PROCESS.md — cómo publicar versiones.
- docs/DEPLOYMENT.md — packaging y firma.
- docs/LAN_SETUP.md — configuración multi-caja.
- docs/MERCADOPAGO_SETUP.md — integración MP QR.
- BACKLOG.md — pendientes generales.

## Cerebro

- proyectos/stockflow.md — ficha del proyecto.
- sessions/2026-05-21-stockflow-fixes-saldos-impresion-ventanas.md — sesión de fixes.
- modulos/thermal-print.md — patrón de impresión térmica (referencia).
