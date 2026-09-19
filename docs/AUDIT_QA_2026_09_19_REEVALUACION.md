# Reevaluación de calidad — StockFlow (19-sep-2026)

Segunda pasada sobre `docs/AUDIT_QA_2026_09_18.md` (nota general 5,5) después de las tandas 1–7 de `docs/HOJA_DE_RUTA_QA_2026_09.md`. Siete revisores releyeron el código en HEAD (`439b81f`), corrieron los smokes y reprodujeron en bases temporales lo que quedó abierto. Mismo criterio que el informe original: 10 = nada que toque plata, stock, fiscal o seguridad, y con tests que lo cubran. Drift schema/DB y clave maestra quedaron fuera por decisión del dueño y no cuentan en ningún sentido.

## 1. Nota general: **7,5 / 10** (antes 5,5)

El promedio de áreas da 7,7 y no se redondea para arriba porque siguen reproducibles casos con plata —C1 con pago con tarjeta devuelto en efectivo (`sale.repository.ts:560`), devolución de compra sin tope (`return.repository.ts:399`) y los PDFs de `fiscal:archivarPendientes` con número falso— y `saldos.regression.smoke.ts` quedó rojo; no baja a 7 porque los 4 críticos y la omisión crítica del informe están cerrados en el flujo normal y ahora hay smokes que los reproducen (devoluciones, pdv-caja, backup, seguridad-lan, fiscal-importes).

## 2. Tabla por área

| Área | Antes → Ahora | En una frase |
|---|---|---|
| Núcleo ventas-stock-caja | 6 → 7,5 | Anular con devolución previa, reintegro con descuento y reverso electrónico están cerrados y testeados; C1 sigue abierto para pagos no físicos y la DPC no prorratea ni tiene tope. |
| Fiscal ARCA | 5 → 7,5 | `arcaAmounts` cierra al centavo por construcción (108.000 casos) y el papel lleva el número de ARCA; `archivarPendientes` sigue armando PDFs con número interno y el forzado a RI se comió una validación. |
| DB y migraciones | 6,5 → 8 | Backup por API de SQLite, retención por nombre y restore validado con 35 checks; el reinicio de operativa sigue cayendo con cualquier `mp_order` sin venta. |
| Seguridad IPC/LAN | 6 → 8 | JWT con secreto aleatorio, allowlist antes del lookup e `imagePath` fuera del payload, 70 checks; quedan el webview con popups y la licencia en servidor por regex de verbo. |
| UI ventas/caja | 6 → 7,5 | Sin doble venta esperando el CAE, el QR factura y el cliente se resetea; el prefill del pedido web permite cobrar dos veces y el split falla en el medio centavo exacto. |
| Catálogo web | 6 → 7,5 | Pago del pedido calculado como el servidor, permisos en los 12 canales, avisos con reintento; la carrera entre terminales sigue generando dos ventas y `pedidoVincularVenta` devuelve ok en silencio. |
| Migración + backup | 6 → 8 | migrar.py resuelve cliente, CC, NROCOMP y una sola transacción; `archivarPendientes` ignora los `fiscal_vouchers` que ahora crea y migrar.py sigue sin un test. |

## 3. Parcial o sin resolver

**Toca plata / stock**
- C1 residual — `packages/db/src/repositories/sale.repository.ts:560`: sólo descuenta lo reintegrado de los pagos físicos; venta $2000 con débito + DEV 1u efectivo + anular → Σ egresos $3000 (reproducido); mixto 500+1500 → $2500. Cta. cte. + DEV efectivo + anular → AR borrada y egreso $1000 sin contrapartida.
- Devolución de COMPRA sin prorrateo ni tope — `return.repository.ts:399-423`: compra 2u×$1000 con descuento $200 → dos DPC reintegran $2000 sobre $1800 pagados; en net devuelve $1000 sobre $1210. La hoja de ruta lo pasó a tanda 7 y no se hizo.
- A18 residual — `apps/desktop/electron/ipc/handlers/catalogo.handlers.ts:327-335`: en `pedidoConvertir` la venta se crea antes del compare-and-set (dos terminales → dos ventas); `pedidoVincularVenta` devuelve `{ok:true}` aunque otra terminal ya haya convertido el pedido con otra venta.
- Prefill del pedido web — `apps/desktop/src/pages/Ventas.tsx:784-816`: `replaceState` no quita `__extras` del hash; cierre+apertura de caja o reload recarga el carrito y permite cobrar el mismo pedido dos veces.
- A1 residual cross-caja — `Caja.tsx:619`, `HistorialCajas.tsx:484`: el reverso electrónico de una caja ya cerrada entra negativo a la actual y el depósito hace `max(0, net)`; sin otros cobros por ese medio, Caja General se queda con la plata de la venta anulada.
- A17 residual — `PedidosWeb.tsx:124` → `Ventas.tsx:799-808`: "Cargar en Ventas" manda el precio final como `unitPrice`; en modo net se le suma IVA encima (sólo net, hoy ningún cliente lo usa).
- A14 residual — `usePaymentSplit.ts`: `isComplete` no redondea; en el borde exacto de medio centavo (432,565) la UI dice completo y el backend rechaza `SALE_PAYMENTS_MISMATCH`.
- Caja cerrada — `cash.service.ts:376`, `createWithLines` de compras contado, pagos a proveedor: venta y cobranza verifican `status='open'` en la tx, pero un ingreso manual y una compra contado siguen entrando a una caja cerrada (reproducido).
- voidSale no atómico con la AR — `packages/core/src/services/sales.service.ts:250-264`: chequeo de pagos y delete fuera de la tx del repo; sin cambios.
- adjustStock sin tx — `inventory.service.ts:56-72`; convertToSale no atómico — `quotes.service.ts:130-156`: sin cambios.

**Toca fiscal**
- Omisión alta abierta — `apps/desktop/electron/ipc/handlers/fiscal.handlers.ts:381-445`: `archivarPendientes` recorre `sales.afipCAE`, pasa `number: venta.number` y `salePoint: puntos[0]`, y busca `findVoucherById(venta.id)` (nunca coincide); en Denver generaría 1.247 PDFs con número interno y PV configurado aunque migrar.py ya crea los `fiscal_vouchers`. Se cuenta una sola vez (Fiscal + Migración).
- Libro IVA Compras — `accounting.service.ts:385`: el vatAmount persistido ya prorratea (`purchase.repository.ts:115`), el reporte al contador sigue sumando `vatBreakdown` sin prorratear.
- Devolución de venta con CAE sin NC ni aviso — `HistorialVentas.tsx:614`, `ReturnDialogs.tsx`, `returns.service.ts`: sin cambios (sólo la anulación recibió el aviso).
- Aviso de anulación con CAE — `HistorialVentas.tsx`: depende de `sales.afipCAE`, que sólo llena la migración; `createVoucher` nunca escribe esa columna, así que una venta facturada por StockFlow se anula sin advertencia (`voucherQuery.data?.cae` está en el mismo diálogo y no se usa).
- `issueNote` — `fiscal.service.ts`: no registra el intento ni consulta antes de reintentar (NC con respuesta perdida sale dos veces) y no valida importe (0, > original, acumulado).
- Dos terminales facturando a la vez — `fiscal.service.ts:247`: sin mutex por (PV, tipo); ahora queda `rejected` y el reintento no duplica, pero el cajero ve un error sin explicación.
- Reimpresión desde Historial — `HistorialVentas.tsx:357`: `sellerName` sigue en null; sin CAE, `customerDoc` vacío.

**Toca seguridad / disponibilidad**
- Licencia readOnly en servidor — `LanServer.ts` (`METODOS_DE_ESCRITURA`): regex por prefijo de verbo; `catalogo:syncConfigurar` y `mpQr:verifyPayment` siguen escribiendo con licencia ≠ active.
- Webview WhatsApp — `WelcomeScreen.tsx:68`: `allowpopups='true'` sin `setWindowOpenHandler`; archivo sin tocar.
- `isLanRemote` — `LanServer.ts:191-201`: sigue sin 169.254/16, 100.64/10 ni fd00::/8 (pendiente declarado en la hoja de ruta).
- Traversal por prefijo — `LanServer.ts:355`: `GET /../dist-electron/main.mjs` → 200; `GET /%` → 500 (reproducido; expone sólo código ya público).
- Bajas sin cambio: `packages/core/src/auth/token.ts:13`, `lan:setMode` sin sesión, PIN en `--lan-token` (`main.ts:224`) y en `?pin=`.

**DB / backup / migración**
- A8 residual — `maintenance.repository.ts:206`: `mp_orders.mp_pos_device_id` es NOT NULL sin cascade; una orden QR expirada/cancelada sin venta hace fallar el reinicio entero con `FOREIGN KEY constraint failed` (reproducido; atómico, no pierde datos). El smoke B6 inserta un POS sin órdenes, por eso da verde.
- Backup de salida — `main.ts:561`, `BackupService.ts:62`: tope fijo de 8 s con zlib 9; la base de Denver (90 MB) tarda 2,7–3,0 s en esta Mac, borderline en la PC del cliente; si se pasa, sólo queda un `console.warn`. El de cierre de caja no tiene tope.
- Bajas: retención por mtime (`BackupService.ts:101`), diálogo de restore que sigue diciendo "cerrar y volver a abrir" (`Configuracion.tsx:715`), drizzle-kit con un solo snapshot (`migrations/local/meta/_journal.json`).

**Catálogo**
- 'cancelado' tardío — `catalogo.handlers.ts`: "Publicar ahora" no corre `cancelarPedidosDeVentasAnuladas()` antes de publicar; no se hizo el bump de `updated_at` tras el acuse.
- Bajar un pedido no re-publica los artículos — `catalogo.repository.ts:276`, `CatalogoSync.ts:191`: sin cambios (ventana de sobreventa).
- Sin timeout: acuse 'tomado' (`CatalogoSync.ts:237`), `listarProductosDelCatalogo`, `vincularLote`; tick de 60 s sin guardia de reentrada.
- Bajas: `PedidosWeb.tsx:279` refetch de todo el historial cada 30 s; token en claro en `Empresa.tsx:197` (mitigado: sólo el admin lo recibe).

**Tono de UI** — `Ventas.tsx:422/1272/1307`, `HistorialVentas.tsx:659`, `Caja.tsx:716` siguen tuteando.

## 4. Riesgos nuevos (introducidos o destapados por las correcciones)

- **media** `fiscal.service.ts:236-242`: el forzado a condición RI en Factura A aplica a cualquier condición no admitida, no sólo CF: un Exento con A forzada se emite como RI (antes `validateForLetter` lo frenaba) y un monotributista de mostrador se declara RI (1) en vez de MT (6), sin la leyenda de la RG 5616. Limitar a `customer.category === 'CF'`.
- **media** `WsaaClient.ts:268`: el `fetch` del login WSAA no tiene timeout y el flag `procesando` (A12) ahora congela F2, botones y atajos; al vencer el TA (cada 12 h) con ARCA colgado, el PDV queda inutilizable hasta el timeout de undici (~5 min).
- **media-baja** `catalogo.handlers.ts:151/216/312/336`: barridos concurrentes sin candado (timer + cada terminal con Pedidos web abierta + `sales:void`); `cancelarPedidosDeVentasAnuladas` espera hasta 8 s por aviso y otro barrido puede mandar el mismo 'cancelado' (el contrato no exige idempotencia para 'cancelado' → doble reposición). `avisarResolucion`/`avisoHecho` se llaman con `void` sin `.catch`.
- **baja** `packages/core/src/tests/saldos.regression.smoke.ts`: 4 checks rojos porque asevera la semántica anterior a A1 ("la transferencia NO genera reverso"); una suite roja tapa regresiones reales.
- **baja** `analytics.service.ts:555-570, :731-739`: resta todas las devoluciones sin mirar el estado de la venta; venta $2000 → DEV $1000 → anular deja −$1000 en "Resumen del día".
- **baja** `Caja.tsx:615-621` + `cashGeneral.service.ts:181`: un reverso electrónico de caja cerrada que deje un medio en negativo hace fallar el depósito de cierre con `DEPOSIT_OVER_ELECTRONIC`.
- **baja** `returns.service.ts:69-71`: `assertPhysicalCashAvailable` y el preview corren fuera de la tx de `createSaleReturn` (TOCTOU en red).
- **baja** `WsfeClient.call`: `res.text()` fuera del try; un timeout durante la lectura del cuerpo se registra como `rejected` y el reintento no consulta ARCA. El reintento con `FECompConsultar` tampoco filtra por `voucherCode` (B perdida reintentada como A → segundo comprobante).
- **baja** `CobroQrModal.tsx`: en fase 'approved' Escape/overlay desmontan el modal y cancelan el aviso de 1,5 s → pago aprobado en MP sin venta registrada.
- **baja** `migrar.py:1172-1176`: cuando las ventas reales explican el total de la cuenta, la AR entera cuelga de la última venta a cuenta y anularla la borra; `migrar.py:1231`: motivo COMPRA toma la fecha de una venta ajena; `migrar.py:883-888`: `venta_cuenta` suma anuladas.
- **baja** `LanServer.ts`: bloqueo por PIN por IP de 10 min que tapa también al PIN correcto (soporte tras rotar el PIN); `cargarSafeStorage` cae a texto plano sin log; `licenseManager.getState()` con I/O síncrona en cada RPC.
- **baja** `catalogo.repository.ts:187` (sólo net): multiplica en punto flotante antes de `redondearExacto` (102,50 × 1,21 → 124,02); la tolerancia de $0,01 en `pedidoConvertir` rechaza pedidos legítimos de cantidades grandes.
- **baja** `maintenance.repository.ts`: al conservar ventas con CAE se conservan sus cajas con todos los movimientos; `init.ts` corre `foreign_key_check` en cada arranque (0,5 s sobre 90 MB).

## 5. Smokes corridos (desde `apps/desktop`, `ELECTRON_RUN_AS_NODE=1 electron` + tsx)

| Smoke | Resultado |
|---|---|
| `devoluciones.smoke.ts` | OK, 21 checks (anular con DEV previa, DPC previa, reintegro prorrateado/net/tope, efectivo insuficiente) |
| `pdv-caja.smoke.ts` | OK, 36 checks (reverso electrónico, CASH_CLOSED en tx, motivo, depósito con desglose, IVA compras, transferencias) |
| `fiscal-importes.smoke.ts` | OK (88.000 casos de grilla, dos alícuotas, XML factura/NC, reintento FECompConsultar ×4, letra por emisor) |
| `fiscal.smoke.ts` / `fiscal-xml.smoke.ts` | OK (RG 5616, documento en la venta, NC, fecha del QR, campo posicional) |
| `backup.smoke.ts` | OK, 35 checks (WAL sin checkpoint, timeout sin .tmp, retención, restore inválido, `.pre-restore`); otra corrida reportó 28 |
| `seguridad-lan.smoke.ts` | OK, 70 checks (C3, A9, A10, fuerza bruta, licencia en servidor, rotación de PIN, company:get, catalogo:*) |
| `lan.smoke.ts` | OK, 26 checks |
| `catalogo.smoke.ts` | OK, 51 checks (B1–B6) |
| `hardware.smoke.ts` | OK (ticket fiscal ESC/POS: número ARCA, cond. IVA, QR `GS ( k`, B sin IVA discriminado; BackupService) |
| `packages/db` `repositories.smoke.ts` / `local.smoke.ts` | OK, sólo bajo el Node de Electron (`pnpm test:smoke` falla por ABI de better-sqlite3) |
| `packages/core` `saldos.regression.smoke.ts` | **ROJO**, 4 checks (aseveran la semántica anterior a A1; no se actualizó) |
| Typecheck renderer (`tsc -p tsconfig.app.json`) | limpio |

Sin test: `migrar.py` (0 tests), `pedidoConvertir` de punta a punta, la carrera `pedidoVincularVenta`, `usePaymentSplit`, `voucherOptions`, `procesando`, el prefill y `CobroQrModal`, el camino "A de mostrador" en el servicio, el QR ESC/POS en la POS-58 real. Los repros propios corrieron en bases temporales del scratchpad; no se tocó la base real ni ningún archivo del repo.

## 6. Cierre

Para 8+ hace falta cerrar lo que todavía mueve plata: C1 para pagos no físicos y cta. cte. (`sale.repository.ts:560`), la DPC con prorrateo y tope (`return.repository.ts:399`), la venta creada antes del CAS en `pedidoConvertir` y el prefill que cobra dos veces (`Ventas.tsx:784`).
Y lo fiscal que hoy afecta a Denver: `archivarPendientes` buscando el voucher por `sale_id` (`fiscal.handlers.ts:381`), el forzado a RI limitado a CF (`fiscal.service.ts:236`), timeout en el login WSAA y el Libro IVA Compras prorrateado (`accounting.service.ts:385`).
Además, `saldos.regression.smoke.ts` en verde y un primer test para `migrar.py`; sin eso, cada área queda con un caso con plata reproducible y la nota no pasa de 7,5–8.
