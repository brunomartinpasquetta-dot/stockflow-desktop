# Hoja de ruta — correcciones de la auditoría de calidad (sep-2026)

Origen: `AUDIT_QA_2026_09_18.md` (nota 5,5/10). Regla: **cada tanda se cierra con su
smoke test y un commit en `main`; nada se taggea hasta que Bruno lo diga.** El orden
es por daño (plata y stock primero) y por dependencia (lo que arregla varias cosas
a la vez va antes).

Estado: `[ ]` pendiente · `[~]` en curso · `[x]` hecho (commit).

## Tanda 1 — Plata y stock que se duplican (críticos)
- [x] **Anular venta con devolución previa** (`sale.repository.ts:452`): dentro de la
  misma transacción leer `return_lines`; reponer sólo (cantidad − devuelto) y revertir
  en caja sólo (total − Σ devoluciones). Si ya se devolvió todo, rechazar con mensaje. — `packages/db/src/repositories/sale.repository.ts`
- [x] **Anular compra con devolución al proveedor previa** (`purchase.repository.ts:357`):
  espejo exacto de lo anterior. — `packages/db/src/repositories/purchase.repository.ts`
- [x] **Devolución** (`return.repository.ts:135`, `ReturnDialogs.tsx:61`): unitario
  efectivo = importe de línea × (total/subtotal) para prorratear el descuento global;
  en modo `net` sobre el bruto con IVA; tope Σ reintegros ≤ total de la venta; el
  reintegro en efectivo exige efectivo disponible en caja. — `packages/db/src/repositories/return.repository.ts` (+ `returns.service.ts`, `ReturnDialogs.tsx`)
- [x] Smoke nuevo `devoluciones.smoke.ts`: venta → devolución parcial → anular;
  descuento global; modo net; efectivo insuficiente; compra → devolución → anular. — `apps/desktop/electron/__tests__/devoluciones.smoke.ts`
- [ ] Pendiente (fuera de tanda): devolución de COMPRA con descuento global / modo net
  (`createPurchaseReturn`) → se espeja en tanda 7 junto con 'IVA de compras con descuento global';
  venta a cuenta corriente con DEV en efectivo y luego anulada deja el egreso sin contrapartida (decidir).

## Tanda 2 — Backup que no sirve
- [x] **Copia con WAL abierto** (`BackupService.ts:69`): usar `db.$client.backup()` (o
  `VACUUM INTO`); mínimo `wal_checkpoint(TRUNCATE)` antes de copiar. — `BackupService.ts` (API de backup de SQLite, copia en tmp local)
- [x] **Pre-quit** (`main.ts:529`): cerrar la base antes, `setBackupDir` con la carpeta
  configurada, y sin cortar a los 8 s con el `.tmp` a mitad. — `main.ts` (+ `window-all-closed` ya no mata el backup en Windows; verificar en la PC Windows con un backup grande)
- [x] **Limpieza** (`BackupService.ts:192`): borrar sólo `stockflow-AAAA-MM-DD-HHMMSS.zip`,
  conservar todos los de los últimos N días, retención también en cierre de caja y salida. — `BackupService.ts`, `cash.handlers.ts`, `main.ts`
- [x] **Restore** (`BackupService.ts:129`): copia `.pre-restore-<ts>` + cabecera SQLite +
  `quick_check` antes de pisar. — `BackupService.ts`
- [x] Smoke: backup con la base abierta y 300 filas sin checkpoint → el zip las tiene. — `backup.smoke.ts`

## Tanda 3 — ARCA: lo que viaja y lo que se imprime
- [x] **Importes** (`fiscal.service.ts:244`, `:216`, `:238`, `:378`): IVA redondeado y
  neto = total − IVA; `AlicIva` sobre líneas ya prorrateadas por el descuento global;
  con dos alícuotas, neto = Σ bases redondeadas; lo mismo en notas de crédito. — `packages/shared/src/fiscal/importes.ts` (`arcaAmounts`, usada en factura y nota)
- [x] **WSFE** (`WsfeClient.ts:145`): timeout 30 s; antes de reintentar,
  `FECompConsultar(N+1)` para no emitir dos comprobantes por la misma venta. — `WsfeClient.ts`, `fiscal.service.ts` (se consulta el número que pidió el intento sin respuesta, no N+1: cubre otra venta facturada entre medio y no adopta tras un rechazo explícito)
- [x] **Papel** (`printSaleTicket.ts:70`, `PrinterService.ts:458-531`): PV-número de ARCA
  en ticket/A4/ESC-POS, QR RG 4892 y condición IVA en el ESC-POS, sin discriminar IVA
  en B/C. — `printSaleTicket.ts`, `SaleTicket.tsx`, `PrinterService.ts` (probar el QR `GS ( k` en la POS-58 de los clientes antes de liberar)
- [x] **PDF archivado** (`fiscal.handlers.ts:239`, `:204`): totales, fecha, alícuotas y
  documento desde el comprobante persistido. — `fiscal.handlers.ts`
- [x] **TA por entorno** (`WsaaClient.ts:151`): cache por entorno + hash del cert; borrar
  al guardar la config. — `WsaaClient.ts`, `fiscal.handlers.ts`
- [x] **Reintento desde Historial** (`HistorialVentas.tsx:290`, `:506`): letra por
  `resolveVoucherLetter`, pedir documento del receptor como en Ventas. — `HistorialVentas.tsx` (la regla de la letra replicada como en Ventas: el renderer no importa shared; el servicio la resuelve igual)
- [x] **Ventas** (`Ventas.tsx:1272`, `:1349`, `:665`, `:86`): flag `procesando` (doble
  venta esperando el CAE); el cobro con QR de MP pide CAE; Factura A con CUIT tipeado
  usa ese documento para la condición IVA y `canConfirm` la bloquea si falta; el
  desplegable sólo ofrece letras que el emisor puede emitir. — `Ventas.tsx`, `fiscal.service.ts` (`canCobrarQr` también bloquea la A sin CUIT)
- [x] Smoke: grilla de importes (enteros 1..10.000, con descuento, dos alícuotas) →
  neto + IVA = total y Σ BaseImp = neto, siempre. — `fiscal-importes.smoke.ts` (+ reintento con `FECompConsultar` simulado: timeout, otra venta entre medio, rechazo explícito)
- [ ] Pendiente (fuera de tanda): prefill del CUIT tipeado en el Historial cuando el
  intento de Ventas falló (hoy hay que volver a tipearlo); match del reintento si el
  timeout cruza medianoche (hoy no adopta y emite otro); B/C en modo `net` siguen
  mostrando IVA aparte en el ESC/POS (ningún cliente trabaja en net).

## Tanda 4 — Seguridad en red
- [x] **JWT LAN** (`LanServer.ts:346`): secreto aleatorio de 32 bytes en safeStorage; el
  PIN sólo empareja. — `LanManager.ts` (`getOrCreateJwtSecret`/`rotateJwtSecret`, en lan.json
  pero FUERA de `LanConfig`: `lan:getConfig` no lo devuelve), `LanServer.ts` (`opts.jwtSecret`;
  sin él genera uno por proceso, nunca cae al PIN), `main.ts`
- [x] **Canales expuestos** (`main.ts:362`): allowlist de grupos para /lan/rpc, 403 al
  resto (`license:*`, `updater:*`, `lan:*`, `system:pickFile`). — `preload-bridge.ts`
  (`lanServerAccepts`: la misma `LAN_ROUTED_GROUPS` que rutea el cliente + `LAN_SERVER_DENIED_CHANNELS`:
  `backup:restore`, `maintenance:*`, `users:create/update/delete`, `roles:setConfig`, `demo:load/remove/restart`;
  las lecturas de users/roles/demo pasan para que las pantallas abran en las terminales)
- [x] **imagePath** (`articles.handlers.ts:172`): fuera del schema de update; resolver
  siempre dentro de la carpeta de imágenes. — `articles.handlers.ts` (`sinImagePath` en create/update,
  `rutaDeImagen` con chequeo de prefijo en get/remove/delete/upload)
- [x] **Permisos** (`catalogo.handlers.ts:54`, `company.service.ts:14`): los 11 canales
  `catalogo:*` con `requirePermission`; `company:get` sin el token del catálogo para
  quien no es admin. — `catalogo.handlers.ts` (manage_company / create_sale / void_sale-o-manage_company /
  view_articles / view_reports), `company.service.ts` (`catalogoToken: null` sin `manage_company`)
- [x] **Fuerza bruta** (`LanServer.ts:404`): contador por IP + bcrypt async; rotación
  del PIN desde la UI; licencia readOnly también en el servidor. — `LanServer.ts` (5 PIN / 10 logins
  fallidos en 10 min → 429 + Retry-After; PIN en tiempo constante; licencia ≠ active → 403 en métodos de
  escritura), `user.repository.ts` (`bcrypt.compare`), `lan.handlers.ts` (`lan:setMode` acepta PIN nuevo o
  `regeneratePin` y rota el secreto), `Configuracion.tsx` (manda el PIN sólo si cambió + aviso de que las
  terminales deben reingresar)
- [x] Smoke lan: rol vendedor contra canales admin → 403; PIN equivocado ×N → bloqueado. — `seguridad-lan.smoke.ts`
  (+ `lan.smoke.ts` ajustado: `system:*` ya no cruza la red)
- [ ] Pendiente (fuera de tanda): el PIN sigue viajando en la línea de comandos del renderer
  (`--lan-token`) y en la URL de acceso de la terminal web (`?pin=`): al rotarlo, los accesos
  directos de las terminales por navegador hay que rehacerlos; `isLanRemote` sin APIPA/CGNAT.

## Tanda 5 — Punto de venta y caja ✅ (18-sep-2026)
- [x] `clearSale` vuelve a Consumidor Final y lista 1 (`Ventas.tsx`).
- [x] Pago mixto: el último medio absorbe la diferencia de centavos (`usePaymentSplit.ts`), así
  lo que se manda cierra al diezmilésimo como exige `SALE_PAYMENTS_MISMATCH`.
- [x] Anulación de venta electrónica: se emite el reverso `expense` con el medio original
  (`sale.repository.ts` voidSale); el neto por medio, el neto electrónico y lo depositable
  quedan en cero. Si la caja original está cerrada, el reverso entra a la caja abierta actual.
  El historial resta los reversos del "ingresos por medio" (`cash.service.ts`).
- [x] Caja `open` verificada dentro de la transacción de venta y de cobranza (`CASH_CLOSED`).
- [x] Atajos F2/F4/F12/F10/Escape ignoran diálogos abiertos y el procesamiento en curso;
  lista 2/3 en $0 cae a lista 1 con aviso (`pricing.ts` + toast); `CobroQrModal` crea UNA
  orden por apertura, cancela la orden si se cierra antes de que MP conteste y avisa
  `onApproved` una sola vez por orden.
- [x] Anulación individual con CAE: aviso de que no da de baja en ARCA + motivo persistido en
  las notas de la venta con usuario y fecha (`sales:void` acepta `reason`).
- [x] Depósito parcial en Historial de cajas: cada movimiento de Caja General guarda su
  desglose (`cash_amount`/`electronic_amount`, migración 0032, filas viejas por diferencia
  de saldos); el diálogo usa el desglose real.
- Smoke: `pnpm --filter @stockflow/desktop test:pdv-caja` (27 checks).

## Tanda 6 — Catálogo web y reinicio de operativa ✅ (18-sep-2026)
- [x] `marcar()` es compare-and-set (`WHERE estado = 'pendiente'`, devuelve si ganó);
  `pedidoRechazar` y `pedidoConvertir` respetan el resultado; `pedidoVincularVenta` exige que la
  venta exista y no esté anulada (`catalogo.handlers.ts`).
- [x] Pago del pedido calculado como el servidor (`totalComoElServidor`: líneas a 4 decimales,
  IVA prorrateado en modo net, cantidades fraccionadas) y contrastado con `pedido.total`;
  en modo net el catálogo publica el precio FINAL (lista × (1 + IVA)).
- [x] Un pedido inválido no bloquea la cola (validación y try/catch por pedido, sin acuse para
  el roto); `json_type(i.value) = 'object'` en la reserva; ni el temporizador ni "Publicar ahora"
  publican si falló la bajada de pedidos.
- [x] Aviso `confirmado`/`cancelado` con reintento: columna `aviso_pendiente` (migración 0033),
  `avisarResolucion()` + barrido `reintentarAvisosPendientes()` en el temporizador, al listar
  pedidos y en "Publicar ahora".
- [x] `crear_faltantes` configurable (`catalogo_sync.crear_faltantes`, migración 0034, casilla
  en Mi Empresa) y sólo para artículos ACTIVOS: los de baja se publican aparte con `false`.
- [x] **Reinicio de operativa**: conserva las ventas con comprobante autorizado (y su caja),
  desengancha `catalogo_pedidos.sale_id` y los intentos fiscales sin CAE, borra los
  `mp_pos_devices` de las cajas que se van.
- Smoke: `test:catalogo` ampliado (50 checks, secciones B1–B6).

## Tanda 7 — Migración y el resto ✅ (18-sep-2026)
- [x] `migrar.py`: cuentas corrientes sin duplicar (VENTA.IDCUENTA → `is_account_sale`,
  LINEACUENTA.IDLV salteadas, venta sintética sólo con el arrastre), `sale_payments` por
  venta, `COMPRA.NUMERO` alfanumérico con try/except por compra, UNA transacción con
  `foreign_key_check` antes del commit, sin segundo Consumidor Final, renumeración en
  colisión, aviso honesto de claves. Probado de punta a punta con la base real de Denver
  (61.627 ventas, 61.627 pagos, integridad y FK ok); la base regenerada quedó en
  `~/Desktop/DENVER-migracion/PARA-EL-PENDRIVE/`.
- [x] IVA de compras con descuento global prorrateado (`purchase.repository.ts`).
- [x] `transferFromClosed` valida importe, desglose (suma = total) y topes por naturaleza
  (efectivo ≤ contado, electrónico ≤ neto del cierre); `transferFromDaily` verifica el
  efectivo disponible dentro de la transacción.
- [x] `synchronous=FULL`, índice `idx_sales_cash_register` (migración 0035),
  `foreign_key_check` al terminar de migrar en `init.ts`, `local.smoke` y
  `repositories.smoke` en verde.
- [—] Drift schema/DB: **descartado por decisión de Bruno (19-sep-2026)**; no se hace.
- [—] Clave maestra con JWT del cloud: **descartado por decisión de Bruno (19-sep-2026)**; la clave maestra queda como está.
- [x] Tono de UI: ~110 cadenas que tuteaban pasaron a trato formal (pantallas, toasts,
  mensajes del servidor). El asistente Flowy conserva su tono conversacional a propósito.
- Smokes: `test:pdv-caja` sección [6] (9 checks nuevos).

## Cómo se cierra cada tanda
1. Cambio + smoke que lo reproduce antes y lo prueba después.
2. `typecheck` (app y electron) + smokes existentes en verde.
3. Commit en `main` sin tag, con el hallazgo citado.
4. Build en la Mac de Bruno (`package:dry`) y prueba real de la pantalla tocada.

## Tanda 8 — Lo que la reevaluación (7,5/10) dejó con plata reproducible ✅ (19-sep-2026)
- [x] Devolución de COMPRA con descuento global prorrateado, IVA en modo net y tope Σ ≤ total
  (`return.repository.ts`, diálogo con el mismo cálculo). Smoke `devoluciones` [5].
- [x] `pedidoConvertir`: el pedido se RESERVA (compare-and-set) antes de registrar la venta y se
  libera si la venta falla; `pedidoVincularVenta` avisa cuando otra terminal ya cobró el pedido con
  otra venta, y Ventas muestra ese error; el prefill del pedido se saca del hash y verifica que el
  pedido siga pendiente. Smoke `catalogo` (reservar/liberar/confirmarConversion).
- [x] `fiscal:archivarPendientes` archiva desde `fiscal_vouchers` (PV y número de ARCA); las ventas
  con CAE sin comprobante caen al camino viejo, avisado. El aviso de anulación con CAE mira también
  el comprobante persistido.
- [x] Factura A "de mostrador": el forzado a RI sólo aplica a la ficha Consumidor Final.
- [x] Login WSAA con tope de 20 s; el tope de WSFE cubre también la lectura del cuerpo.
- [x] Libro IVA Compras con el descuento global prorrateado. Smoke `pdv-caja` [6].
- [x] Anular con devolución previa y pago electrónico: lo reintegrado se descuenta también de los
  pagos no físicos (`64fa00b`); `saldos.regression.smoke` en verde.

