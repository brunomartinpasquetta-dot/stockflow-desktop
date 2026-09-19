# Tercera medición de calidad — StockFlow (19-sep-2026)

Tercera pasada sobre `docs/AUDIT_QA_2026_09_18.md` (5,5) y `docs/AUDIT_QA_2026_09_19_REEVALUACION.md` (7,5), después de las tandas 8 y 9 (`ff5fc4c`, `45612fd`). Siete revisores releyeron HEAD, corrieron los smokes y reprodujeron en bases temporales del scratchpad lo que quedó abierto; no se tocó la base real. Mismo criterio: 10 = nada que toque plata, stock, fiscal o seguridad, con tests que lo cubran. Drift schema/DB y clave maestra siguen fuera por decisión del dueño.

## 1. Nota general: **8 / 10** (5,5 → 7,5 → 8)

El promedio de áreas da 8,4 y no se redondea para arriba porque en el núcleo siguen reproducibles cuatro casos con plata o arqueo —venta a cuenta + DEV en efectivo + anular (`sale.repository.ts:554`, el mismo que nombraba la reevaluación), su espejo en compras (`purchase.repository.ts:507`), la cobranza de Cuentas Corrientes que entra a una caja cerrada (`payment.repository.ts:181`) y la compra por transferencia anulada sin reverso (`purchase.repository.ts:442`)— y la NC con respuesta perdida se emite dos veces (`fiscal.service.ts`, `issueNote`); sube de 7,5 porque de las diez condiciones del cierre anterior ocho están cerradas con smoke (C1 no físicos/mixtos, DPC con tope, CAS antes de la venta, prefill, `archivarPendientes` desde vouchers, forzado sólo CF, timeout WSAA, Libro IVA) y `saldos.regression.smoke.ts` volvió a verde.

## 2. Tabla por área

| Área | Original → Reeval. → Hoy | En una frase |
|---|---|---|
| Núcleo ventas-stock-caja | 6 → 7,5 → 8 | C1 no físicos/mixtos, DPC con prorrateo y tope, reverso a la caja original y AR en la tx están cerrados y testeados (pdv-caja 54, devoluciones 26); cta. cte. + DEV efectivo + anular sigue dejando $1000 sin contrapartida y `createAccountPayment` entra a caja cerrada. |
| Fiscal ARCA | 5 → 7,5 → 8,5 | `archivarPendientes` archiva con PV y número de ARCA, forzado a RI sólo con ficha CF, candado por (PV, tipo), WSAA con tope; el reintento de NC sin `recordFailure` duplica y "Anular ventas de hoy" no ve las facturas emitidas por StockFlow. |
| DB y migraciones | 6,5 → 8 → 8,5 | Reinicio de operativa limpia `mp_orders` huérfanas (B6) y el backup de salida tiene 25 s con aborto limpio; el `NOT IN (?,…)` del reinicio falla a partir de ~32 k ventas con CAE (reproducido). |
| Seguridad IPC/LAN | 6 → 8 → 8,5 | Licencia en servidor por lista de lectura (259 canales), webview sin popups, `isLanRemote` con APIPA/CGNAT/ULA, traversal y `%` cerrados; `uploadImage.sourcePath` sigue resolviéndose en el disco del servidor. |
| UI ventas/caja | 6 → 7,5 → 8 | Prefill verificado contra pendientes, split con la misma regla que el servidor (barrido 1.094.892), QR aprobado no se pierde con Escape; el renderer sigue sin un test y el QR aprobado con `createSale` fallido no tiene salida. |
| Catálogo web | 6 → 7,5 → 8,5 | Reserva compare-and-set antes de `createSale`, `pedidoVincularVenta` avisa con la venta duplicada, timeouts en los tres fetch; cada "Rechazar" puede mandar dos 'cancelado' y `pedidoConvertir` sigue sin test de punta a punta. |
| Migración + backup | 6 → 8 → 8,5 | Denver queda cubierto por `archivarPendientes`, backup de salida con tope propio y retención encadenada; `migrar.py` sigue con 0 tests y la Factura A migrada se archiva sin tabla de alícuotas. |

## 3. Parcial o sin resolver

**Toca plata / arqueo**
- C1 residual cta. cte. — `packages/db/src/repositories/sale.repository.ts:554` (`if (!sale.isAccountSale)`): venta a cuenta 2u×$1000, DEV 1u con reintegro en efectivo, anular → la AR se borra y el egreso de $1000 queda sin contrapartida (repro R1). `ReturnDialogs.tsx` permite 'cash' en ventas a cuenta. La hoja de ruta lo dejó en "(decidir)" y no se decidió.
- Caja cerrada, cobranza a nivel cuenta — `payment.repository.ts:181` (`createAccountPayment`, usado por `CuentasCorrientes.tsx:157`): sin chequeo `open` en la tx; con la caja cerrada por otra terminal el ingreso entra al arqueo ya hecho (repro R2). Sólo `createPayment` recibió el chequeo.
- Depósito de cierre con medio electrónico negativo — `Caja.tsx:615-621`, `HistorialCajas.tsx:484` vs `cashGeneral.service.ts:181`: la UI propone Σ max(0, neto por medio) y el servidor topea con el neto de todos; Tarjeta +1000 y Transferencia −400 → `DEPOSIT_OVER_ELECTRONIC` "queda por ingresar 600" (repro R3).
- Sin cambios desde la reevaluación: `adjustStock` sin tx (`inventory.service.ts:56-72`), `convertToSale` no atómico (`quotes.service.ts`), `previewSaleReturn` + `assertPhysicalCashAvailable` fuera de la tx (`returns.service.ts:69-72`).

**Toca fiscal**
- `issueNote` — `packages/core/src/services/fiscal.service.ts`: valida importe y acumulado, pero sin `recordFailure` ni consulta previa; una NC con TIMEOUT se reintenta con `lastAuthorized+1` y sale una segunda NC. El chequeo de acumulado corre fuera del candado.
- "Anular ventas de hoy" — `HistorialVentas.tsx:71` y `sales.service.ts:360` (`voidSalesInRange`) cuentan `conCAE` sólo por `sales.afipCAE`, que `createVoucher` nunca escribe: un día de facturas emitidas por StockFlow se anula en lote con "0 tienen CAE".
- Reimpresión desde Historial — `HistorialVentas.tsx:411`: `sellerName` en null y `customerDoc` vacío sin CAE (baja).

**Toca seguridad**
- `lan:setMode` sin sesión (local, para el wizard), `packages/core/src/auth/token.ts:13`, PIN en `--lan-token` (`main.ts:242`) y en `?pin=`, bloqueo por IP que tapa al PIN correcto, `cargarSafeStorage` sin log (`LanManager.ts:33-50`), `getState()` síncrono por RPC: bajas sin cambio.

**DB / backup / migración**
- `migrar.py` — `tools/migracion/migrar.py`: sigue con 0 tests; `git diff ff5fc4c~1..HEAD -- tools/` vacío. Bajas sin cambio: `:1172-1176` (AR entera colgada de la última venta a cuenta, hoy borrable por `voidSale` en tx), `:1231` (motivo COMPRA con fecha de venta ajena), `:883-888` (`venta_cuenta` suma anuladas).
- Retención por mtime (`BackupService.ts:176`), diálogo de restore que dice "cerrar y volver a abrir" (`Configuracion.tsx:716`), drizzle-kit con un solo snapshot, cajas conservadas enteras en el reinicio, `foreign_key_check` en cada arranque (`init.ts`).

**Catálogo**
- 'cancelado' tardío — `CatalogoSync.ts:376-380`: sigue sin `tocarArticulos()` tras el acuse; un 'cancelado' que entra después de una publicación deja stock de más en la tienda hasta el próximo cambio del artículo.
- Barridos vs aviso directo — `catalogo.handlers.ts:151/216/312/336`: hay candado entre barridos pero no entre `pedidoRechazar` y `reintentarAvisosPendientes`; `void avisarCatalogo(...)` sin `.catch`. `traerPedidos` (`main.ts:365`) sin guardia de reentrada.
- Pedido pagado con envío/cupón — `PedidosWeb.tsx:232-250`: `pedidoConvertir` lo rechaza (correcto) y no hay botón para cargarlo en Ventas; queda pendiente reservando stock hasta que alguien lo rechace.
- Bajas: `PedidosWeb.tsx:279-283` trae todo el historial cada 30 s; token en `<Input>` de texto (`Empresa.tsx:197`); `Ventas.tsx:835` pisa un carrito en curso sin preguntar.

**UI / tono** — A18 lado Ventas: "Cargar en Ventas" no reserva; la segunda terminal recibe el error pero venta, stock y caja ya se tocaron. Tutean todavía `Ventas.tsx:1296/1331` y `Caja.tsx:713`.

## 4. Riesgos nuevos (introducidos o destapados por las tandas 8 y 9)

- **media-baja** `purchase.repository.ts:507` + `purchases.service.ts:277-278`: compra a cuenta 2u×$1000, DPC 1u con reintegro en efectivo, anular → la AP se borra y el ingreso de $1000 queda sin contrapartida (repro R4); la AP se sigue borrando en el servicio, fuera de la tx del repo (lo de `voidSale` no se replicó en `voidPurchase`).
- **media-baja** `purchase.repository.ts:442-450`: `voidPurchase` sólo revierte egresos físicos; una compra pagada por transferencia y anulada deja el neto electrónico subestimado y Caja General recibe menos que el banco (repro R3). `saldos.regression.smoke.ts` S05 asevera ese comportamiento como correcto.
- **media-baja** `maintenance.repository.ts:135/204/215/219/243`: listas de conservados inline en `NOT IN (?,…)`; tope de 32.766 variables de SQLite 3.49.2 → 30.000 ventas con CAE reinician en 750 ms, 33.000 fallan con "too many SQL variables" (reproducido). Arreglo: tabla temporal de ids.
- **media-baja** `catalogo.handlers.ts` (`pedidoRechazar`) + `reintentarAvisosPendientes`: doble POST `/pedidos/:id/estado {cancelado}` casi simultáneo por el mismo pedido; el contrato (CATALOGO_WEB_API.md 3.5) no exige idempotencia para 'cancelado' → doble reposición en la tienda.
- **media-baja** `Ventas.tsx` (`confirmarConQrAprobado`): pago aprobado en MP y `createSale` falla (CASH_CLOSED, stock) → orden aprobada sin venta, sin camino para re-asociarla; reintentar abre otra orden y el cliente puede pagar dos veces (pre-existente, ahora sin salida).
- **media-baja** `tools/migracion/migrar.py` + `fiscal.handlers.ts:187-195`: la migración no inserta `fiscal_voucher_vat` y `archivar()` ahora confía en el comprobante persistido; la Factura A migrada se archiva sin "DETALLE DE ALÍCUOTAS" (`archivoFacturas.ts:237-270`).
- **baja-media** `fiscal.service.ts:281-288` (residual del forzado): monotributista de mostrador (ficha CF + CUIT tipeado + A) se declara RI (1) en vez de MT (6), sin leyenda 10217. `HistorialVentas.tsx` `aDeMostrador` no mira la categoría: un Exento con A forzada rebota en `validateForLetter` y sólo sale cambiando el tipo de documento.
- **baja** `fiscal.service.ts:226-234`: `findVoucherBySale` fuera de `conCandadoDeEmision` y sin UNIQUE en `sale_id`; dos pedidos concurrentes por la misma venta emiten dos facturas (N+1, N+2).
- **baja** `sales.service.ts:279-316`: `reflejarReintegroElectronicoEnCajaGeneral` corre fuera de la tx y traga el error con `console.error`; `cashGeneral.service.ts:169-183` calcula `maxElectronic` antes de la tx de `transferFromClosed`.
- **baja** `articles.handlers.ts:141-162`: `uploadImage.sourcePath` se resuelve en el disco del servidor sin carpeta base; un manager por LAN lee cualquier imagen ≤2 MB (oráculo de existencia; UNC en Windows). `backup:get-config` cae como escritura en la lista de lectura (`LanServer.ts:137-155`) → 403 con licencia readOnly.
- **baja** `maintenance.repository.ts:264`: orden QR de venta conservada con POS de caja no conservada rompe el reinicio por FK (reproducido, improbable). `BackupService.cleanupOldBackups:299-326` sin piso de "últimos N" y ahora automático: reloj adelantado > 1 año borra todo salvo el recién creado. `main.ts:536/579`: `releaseSingleInstanceLock()` antes del backup de salida. Los CAE de homologación se conservan como legales (`maintenance.repository.ts:97-104`).
- **baja** `catalogo.handlers.ts:315-331`: reserva huérfana si el proceso muere entre `reservar()` y `confirmarConversion()` (pedido 'convertido' con `sale_id NULL`, sin barrido de recuperación); `:352-363` pide anular una venta legítima si el pedido fue rechazado por otra terminal.
- **baja** `Ventas.tsx:784-840`: el prefill no espera `companyQuery` (net entra con IVA encima si los artículos resuelven antes); `addArticleWithQty` avisa "sin precio en Lista 2/3" aunque aplique mayorista; el buscador acepta artículos durante `procesando`. `FormalDocA4.tsx:240-259` y `SaleTicket.tsx:169-191` muestran Subtotal con IVA + IVA en la A gross (la térmica sí neto).
- **baja** `migrar.py:929` `int(nro or 0)` aborta con NROCOMP texto; `:366-367` cierra `sq` antes de `sys.exit` y tapa el mensaje; `numero_libre` no ve ventas preexistentes; anular una venta migrada de contado hoy saca efectivo de la caja abierta (`sale.repository.ts:560-650`).
- **cobertura**: nada de las tandas 8/9 tiene smoke en Fiscal (candado, tope de NC, forzado CF, `archivarPendientes`, filtro voucherCode/PV) ni en Seguridad (`isLanRemote`, traversal, popups); `pedidoConvertir`/`pedidoVincularVenta`/`pedidoRechazar` sin test de punta a punta; el renderer sin runner.

## 5. Smokes corridos (desde `apps/desktop`, `ELECTRON_RUN_AS_NODE=1 electron` + tsx; bases temporales)

| Smoke | Resultado |
|---|---|
| `devoluciones.smoke.ts` | OK, 26 checks ([1]–[5]: anular con DEV/DPC previa, prorrateo/net/tope en ventas y compras, efectivo insuficiente) |
| `pdv-caja.smoke.ts` | OK, 54 checks ([1]–[10]: reverso a la caja original y a Caja General, CASH_CLOSED en venta/cobranza por comprobante/manual/compra/pago a proveedor, depósito con desglose, IVA compras, C1 con débito, AR en la tx) |
| `fiscal-importes.smoke.ts` / `fiscal.smoke.ts` / `fiscal-xml.smoke.ts` | OK, 33 + 32 + 32 checks (grilla 1..10.000, XML con descuento y dos alícuotas, reintento ×4, RG 5616, NC, campo posicional) |
| `backup.smoke.ts` | OK, 28 checks (WAL por conexión viva y propia, timeout sin .tmp, retención, restore truncado/no-SQLite/dañado/sano, `.pre-restore` única) |
| `seguridad-lan.smoke.ts` / `lan.smoke.ts` | OK, 70 + 26 checks (JWT con PIN → 401, allowlist, 429, readOnly por lista de lectura, rotación de PIN, imagePath, catalogo:* por rol) |
| `catalogo.smoke.ts` | OK, 58 checks (B1 reservar/liberar/confirmarConversion, B2 net, B3–B5, B6 reinicio con orden QR huérfana, reserva 18→15→18) |
| `hardware.smoke.ts`, `flows.smoke.ts` | OK (BackupService con base cerrada; flujos de Flowy, no pertenece al núcleo) |
| `packages/db` `local` / `migracion` / `repositories` | OK bajo el Node de Electron (42 tablas, 0021 con datos, 0 FK rotas) |
| `packages/core` `saldos.regression.smoke.ts` | **OK** (antes rojo; S04 asevera el reverso de transferencia; S05 fija la asimetría de `voidPurchase`) |
| Typecheck renderer (`tsc -p tsconfig.app.json`) | limpio |

Repros propios (scratchpad, sin tocar repo ni `~/Library`): R1 cta. cte. + DEV efectivo + anular; R2 `createAccountPayment` a caja cerrada; R3 compra por transferencia anulada y `DEPOSIT_OVER_ELECTRONIC`; R4 compra a cuenta + DPC efectivo + anular; R5 mixto 500+1500 → Σ egresos $2000 (correcto); reinicio con 30.000/33.000 ventas con CAE; sonda HTTP contra el LanServer (traversal, `%`, readOnly, token no-string); barrido de `usePaymentSplit` (735.588 combinaciones completas, 0 rechazos del servidor).

## 6. Cierre

Para pasar de 8 hace falta cerrar los cuatro repros con plata del núcleo: `isAccountSale` en `sale.repository.ts:554` y su espejo en `purchase.repository.ts:507` (o bloquear 'cash' en ventas/compras a cuenta desde `ReturnDialogs.tsx`), el chequeo `open` en `createAccountPayment` (`payment.repository.ts:181`) y el reverso electrónico de `voidPurchase` (`purchase.repository.ts:442`) con el S05 dado vuelta.
En fiscal, `recordFailure` + `FECompConsultar` en `issueNote` como ya tiene la factura, el conteo de "Anular ventas de hoy" por `fiscal_vouchers` (`HistorialVentas.tsx:71`, `sales.service.ts:360`) y `findVoucherBySale` dentro del candado (`fiscal.service.ts:226`); en DB, tabla temporal en vez de `NOT IN` para el reinicio (`maintenance.repository.ts:135`).
Y cobertura: un primer test de `migrar.py`, checks para el candado y el tope de NC, y `pedidoConvertir` de punta a punta; sin eso, 8,5 es el techo y 9 no se justifica.
