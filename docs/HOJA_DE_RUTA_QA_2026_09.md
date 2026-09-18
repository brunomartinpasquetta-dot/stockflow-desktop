# Hoja de ruta — correcciones de la auditoría de calidad (sep-2026)

Origen: `AUDIT_QA_2026_09_18.md` (nota 5,5/10). Regla: **cada tanda se cierra con su
smoke test y un commit en `main`; nada se taggea hasta que Bruno lo diga.** El orden
es por daño (plata y stock primero) y por dependencia (lo que arregla varias cosas
a la vez va antes).

Estado: `[ ]` pendiente · `[~]` en curso · `[x]` hecho (commit).

## Tanda 1 — Plata y stock que se duplican (críticos)
- [ ] **Anular venta con devolución previa** (`sale.repository.ts:452`): dentro de la
  misma transacción leer `return_lines`; reponer sólo (cantidad − devuelto) y revertir
  en caja sólo (total − Σ devoluciones). Si ya se devolvió todo, rechazar con mensaje.
- [ ] **Anular compra con devolución al proveedor previa** (`purchase.repository.ts:357`):
  espejo exacto de lo anterior.
- [ ] **Devolución** (`return.repository.ts:135`, `ReturnDialogs.tsx:61`): unitario
  efectivo = importe de línea × (total/subtotal) para prorratear el descuento global;
  en modo `net` sobre el bruto con IVA; tope Σ reintegros ≤ total de la venta; el
  reintegro en efectivo exige efectivo disponible en caja.
- [ ] Smoke nuevo `devoluciones.smoke.ts`: venta → devolución parcial → anular;
  descuento global; modo net; efectivo insuficiente; compra → devolución → anular.

## Tanda 2 — Backup que no sirve
- [ ] **Copia con WAL abierto** (`BackupService.ts:69`): usar `db.$client.backup()` (o
  `VACUUM INTO`); mínimo `wal_checkpoint(TRUNCATE)` antes de copiar.
- [ ] **Pre-quit** (`main.ts:529`): cerrar la base antes, `setBackupDir` con la carpeta
  configurada, y sin cortar a los 8 s con el `.tmp` a mitad.
- [ ] **Limpieza** (`BackupService.ts:192`): borrar sólo `stockflow-AAAA-MM-DD-HHMMSS.zip`,
  conservar todos los de los últimos N días, retención también en cierre de caja y salida.
- [ ] **Restore** (`BackupService.ts:129`): copia `.pre-restore-<ts>` + cabecera SQLite +
  `quick_check` antes de pisar.
- [ ] Smoke: backup con la base abierta y 300 filas sin checkpoint → el zip las tiene.

## Tanda 3 — ARCA: lo que viaja y lo que se imprime
- [ ] **Importes** (`fiscal.service.ts:244`, `:216`, `:238`, `:378`): IVA redondeado y
  neto = total − IVA; `AlicIva` sobre líneas ya prorrateadas por el descuento global;
  con dos alícuotas, neto = Σ bases redondeadas; lo mismo en notas de crédito.
- [ ] **WSFE** (`WsfeClient.ts:145`): timeout 30 s; antes de reintentar,
  `FECompConsultar(N+1)` para no emitir dos comprobantes por la misma venta.
- [ ] **Papel** (`printSaleTicket.ts:70`, `PrinterService.ts:458-531`): PV-número de ARCA
  en ticket/A4/ESC-POS, QR RG 4892 y condición IVA en el ESC-POS, sin discriminar IVA
  en B/C.
- [ ] **PDF archivado** (`fiscal.handlers.ts:239`, `:204`): totales, fecha, alícuotas y
  documento desde el comprobante persistido.
- [ ] **TA por entorno** (`WsaaClient.ts:151`): cache por entorno + hash del cert; borrar
  al guardar la config.
- [ ] **Reintento desde Historial** (`HistorialVentas.tsx:290`, `:506`): letra por
  `resolveVoucherLetter`, pedir documento del receptor como en Ventas.
- [ ] **Ventas** (`Ventas.tsx:1272`, `:1349`, `:665`, `:86`): flag `procesando` (doble
  venta esperando el CAE); el cobro con QR de MP pide CAE; Factura A con CUIT tipeado
  usa ese documento para la condición IVA y `canConfirm` la bloquea si falta; el
  desplegable sólo ofrece letras que el emisor puede emitir.
- [ ] Smoke: grilla de importes (enteros 1..10.000, con descuento, dos alícuotas) →
  neto + IVA = total y Σ BaseImp = neto, siempre.

## Tanda 4 — Seguridad en red
- [ ] **JWT LAN** (`LanServer.ts:346`): secreto aleatorio de 32 bytes en safeStorage; el
  PIN sólo empareja.
- [ ] **Canales expuestos** (`main.ts:362`): allowlist de grupos para /lan/rpc, 403 al
  resto (`license:*`, `updater:*`, `lan:*`, `system:pickFile`).
- [ ] **imagePath** (`articles.handlers.ts:172`): fuera del schema de update; resolver
  siempre dentro de la carpeta de imágenes.
- [ ] **Permisos** (`catalogo.handlers.ts:54`, `company.service.ts:14`): los 11 canales
  `catalogo:*` con `requirePermission`; `company:get` sin el token del catálogo para
  quien no es admin.
- [ ] **Fuerza bruta** (`LanServer.ts:404`): contador por IP + bcrypt async; rotación
  del PIN desde la UI; licencia readOnly también en el servidor.
- [ ] Smoke lan: rol vendedor contra canales admin → 403; PIN equivocado ×N → bloqueado.

## Tanda 5 — Punto de venta y caja
- [ ] `clearSale` vuelve a Consumidor Final y lista 1 (`Ventas.tsx:931`).
- [ ] Pago mixto: el último medio absorbe la diferencia de centavos (`usePaymentSplit.ts:69`).
- [ ] Anulación de venta electrónica: reverso del pago no físico, o excluir `voided` del
  reparto y del depositable (`cash.service.ts:409`, `:273`).
- [ ] Caja cerrada dentro de la transacción de venta/cobranza (`sale.repository.ts:168`).
- [ ] Atajos F2/F4/F12/Escape ignoran diálogos abiertos (`Ventas.tsx:1422`); lista 2/3 en
  $0 cae a lista 1 con aviso (`pricing.ts:29`); CobroQrModal con guardia de `isPending`.
- [ ] Anulación individual con CAE: aviso + motivo persistido (`HistorialVentas.tsx:310`).
- [ ] Depósito parcial en Historial de cajas: guardar cash/elec por movimiento
  (`HistorialCajas.tsx:490`).

## Tanda 6 — Catálogo web y reinicio de operativa
- [ ] `marcar()` con compare-and-set `WHERE estado='pendiente'`; `pedidoRechazar` chequea
  estado; `pedidoVincularVenta` valida que la venta exista (`catalogo.handlers.ts`).
- [ ] Pago del pedido con `calculateSaleTotals` (net y fraccionados) y `pedido.total`
  (`catalogo.handlers.ts:202`); precio publicado final en modo net (`catalogo.repository.ts:178`).
- [ ] Un pedido inválido no bloquea la cola (try/catch por pedido, `Number.isFinite`);
  `json_type(i.value)='object'`; el timer no publica si falló la bajada
  (`CatalogoSync.ts:191`, `main.ts:346`).
- [ ] Aviso `confirmado`/`cancelado` del rechazo con reintento (columna `aviso_pendiente`).
- [ ] `crear_faltantes` sólo con artículos activos, configurable.
- [ ] **Reinicio de operativa** (`maintenance.repository.ts:206`): conservar ventas con
  comprobante, `catalogo_pedidos.sale_id = NULL`, borrar `mp_pos_devices` de cajas no
  conservadas.

## Tanda 7 — Migración y el resto
- [ ] `migrar.py`: cuentas corrientes sin duplicar renglones (`:953`), `sale_payments` por
  venta, `COMPRA.NUMERO` alfanumérico, una sola transacción, sin segundo Consumidor Final.
- [ ] IVA de compras con descuento global (`purchase.repository.ts:110`).
- [ ] `transferFromClosed`/`transferFromDaily` validan monto y efectivo.
- [ ] `synchronous=FULL`, índice `sales.cash_register_id`, `foreign_key_check` post-migración,
  `repositories.smoke` en verde, drift schema/DB.
- [ ] Clave maestra: JWT firmado por el cloud para el dueño.
- [ ] Tono de UI: las ~25 cadenas que tutean.

## Cómo se cierra cada tanda
1. Cambio + smoke que lo reproduce antes y lo prueba después.
2. `typecheck` (app y electron) + smokes existentes en verde.
3. Commit en `main` sin tag, con el hallazgo citado.
4. Build en la Mac de Bruno (`package:dry`) y prueba real de la pantalla tocada.
