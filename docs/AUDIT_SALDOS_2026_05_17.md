# AUDIT DE SALDOS — 2026-05-17

Auditoría estática del módulo de dinero. **No se modificó código.**
Objetivo: identificar la causa de las diferencias grandes que reporta el cliente
entre saldos de caja diaria, cierres, Caja General y Contabilidad/Reportes.

## RESUMEN EJECUTIVO

- Bugs **BLOCKER** (afectan plata directamente / persistente): **2**
- Bugs **HIGH** (causan diferencias visibles entre reportes o ventanas de inconsistencia): **5**
- Bugs **MEDIUM** (cálculos correctos pero confusos o frágiles): **4**
- Bugs **LOW** (edge cases / legacy): **2**

### Causa raíz dominante

**Hay TRES focos independientes que se combinan y explican las diferencias
grandes que ve el cliente:**

1. **`transferFromDaily` no descuenta de la caja diaria de origen** — la
   transferencia a Caja General sólo SUMA en general; nunca emite el `expense`
   correspondiente en `cash_movements`. Como contabilidad+arqueo histórico
   leen rutas distintas, el dinero queda **duplicado entre la historia de la
   caja diaria y Caja General**. (BUG-S01, BLOCKER.)
2. **`getFinancialSummary.cashValue` NO incluye Caja General** — el saldo
   global de la empresa se calcula sólo con cajas diarias abiertas + sus
   movimientos en efectivo; el balance de `cash_general` queda fuera. El
   "Total activos" subreporta sistemáticamente todo el dinero acumulado en
   la caja fuerte. (BUG-S02, BLOCKER.)
3. **Falta atomicidad entre venta/compra a cuenta y la apertura de la AR/AP**
   — la venta se inserta en una transacción, pero el `create` de
   `accountsReceivable` / `supplierAccountsPayable` es otra llamada. Si el
   proceso muere en el medio, queda venta `isAccountSale=true` SIN cuenta
   asociada. La deuda desaparece silenciosamente. (BUG-S03, HIGH.)

Hay además un nido de bugs más chicos en `void*`, precisión decimal con
`Number()` y bucketización de IVA por alícuotas raras (5%, 2.5%) que
suman ruido pero no son la causa principal del descuadre fuerte.

---

## BUGS POR SEVERIDAD

### BLOCKER

#### BUG-S01: `transferFromDaily` no descuenta el efectivo de la caja diaria de origen

- **Síntoma esperado del usuario:** Al cerrar caja, transferir todo el efectivo
  a Caja General. Después de eso:
  - HistorialCajas muestra la caja cerrada con `closingAmount = X` y
    `expectedCash = X` (todo "queda" ahí).
  - Caja General muestra `+X` por el movimiento `transfer_from_daily`.
  - Si el usuario suma "cierres del día" + "Caja General" en cualquier
    reporte agregado externo o mental, **cuenta X dos veces**.
- **Archivo:** `packages/core/src/services/cashGeneral.service.ts:115-128` +
  `packages/db/src/repositories/cashGeneral.repository.ts:84-143`.
- **Código actual:**
  ```ts
  // cashGeneral.service.ts:115
  async transferFromDaily(input: TransferFromDailyInput) {
    requirePermission(currentUser, 'close_cash');
    assertPositive(input.amount);
    const m = await repos.cashGeneral.addMovement({
      type: 'transfer_from_daily',
      amount: input.amount,
      description: `Transferencia desde caja diaria`,
      category: 'deposit',
      createdBy: currentUser.id,
      referenceId: input.cashRegisterId,
    });
    return this.toDTO(m);
  }
  ```
- **Causa raíz:** El método sólo escribe en `cash_general_movements` (un lado).
  Falta la contrapartida en `cash_movements` del `cashRegisterId` indicado
  (un `expense` con `paymentMethodId` físico). Como la caja diaria **ya está
  cerrada** al momento de la transferencia (es lo que ofrece la UI en
  `Caja.tsx:243-260`), modificar sus movimientos requiere relajar la regla
  ("no se tocan movimientos de una caja cerrada"), o bien:
  - **(opción preferida)** registrar la transferencia ANTES del cierre, así
    el `closingAmount` declarado ya refleja "dinero físico que efectivamente
    queda en el cajón después de mandar X a la caja fuerte".
  - **(opción alternativa)** permitir movimientos post-cierre, recalcular
    el `expectedCash` del cierre con esos movimientos extra, y guardar la
    transferencia con `relatedCashRegisterId` para trazabilidad.
- **Propuesta de fix (opción A, simple y correcta):**
  ```ts
  // 1) UI: ofrecer transferir ANTES de cerrar caja (no después).
  //    El monto restante se cierra como closingAmount.
  // 2) cashGeneral.service.ts: además del addMovement en general,
  //    crear un cash_movement expense en la caja diaria abierta.
  async transferFromDaily(input) {
    requirePermission(currentUser, 'close_cash');
    assertPositive(input.amount);

    return repos.db.transaction(async () => {
      // Validar que la caja esté abierta
      const reg = await repos.cashRegisters.findById(input.cashRegisterId);
      if (!reg || reg.status !== 'open') {
        throw new BusinessRuleError(
          'register_not_open',
          'Sólo se puede transferir desde una caja abierta',
        );
      }
      // Resolver paymentMethodId 'cash' físico
      const cashPm = await repos.paymentMethods.getDefaultCash();
      await repos.cashMovements.create({
        cashRegisterId: input.cashRegisterId,
        type: 'expense',
        description: 'Transferencia a Caja General',
        amount: input.amount,
        paymentMethodId: cashPm.id,
        userId: currentUser.id,
        date: Date.now(),
      });
      const m = await repos.cashGeneral.addMovement({
        type: 'transfer_from_daily',
        amount: input.amount,
        description: 'Transferencia desde caja diaria',
        category: 'deposit',
        createdBy: currentUser.id,
        referenceId: input.cashRegisterId,
      });
      return this.toDTO(m);
    });
  }
  ```
- **Test que faltaba:** "Transferir X desde caja A a Caja General → balance
  general = previous + X **Y** `expectedCash` de A = previous − X". Hoy el
  smoke test (`services.smoke.ts`) sólo verifica el lado de general.
- **Impacto monetario:** TODO el dinero que el cliente haya transferido vía
  el toast aparece duplicado en históricos. Si transfiere $200k/día durante
  un mes → discrepancia acumulada en reportes ad-hoc puede llegar a varios
  millones.

---

#### BUG-S02: `getFinancialSummary.cashValue` NO incluye Caja General

- **Síntoma esperado del usuario:** En "Contabilidad → Resumen financiero",
  el total de activos en caja muestra sólo lo que hay en las cajas diarias
  ABIERTAS. La caja fuerte (Caja General), donde se va acumulando lo que se
  transfiere día a día, **no se suma**. El "total activos" puede estar
  decenas de millones por debajo de la realidad.
- **Archivo:** `packages/core/src/services/accounting.service.ts:92-109`.
- **Código actual:**
  ```ts
  const allRegisters = await this.ctx.repos.cashRegisters.findAll();
  const openRegs = allRegisters.filter((r) => r.status === 'open');
  let cashValue = '0.0000';
  if (openRegs.length > 0) {
    const allPms = await this.ctx.repos.paymentMethods.findAll();
    const cashPmIds = new Set(allPms.filter((p) => p.type === 'cash').map((p) => p.id));
    cashValue = sumDecimals(openRegs.map((r) => r.openingAmount));
    for (const reg of openRegs) {
      const movs = await this.ctx.repos.cashMovements.findByRegister(reg.id);
      for (const m of movs) {
        if (!m.paymentMethodId || !cashPmIds.has(m.paymentMethodId)) continue;
        if (m.type === 'income') cashValue = sumDecimals([cashValue, m.amount]);
        else cashValue = subDecimal(cashValue, m.amount);
      }
    }
  }
  const assetsTotal = sumDecimals([articlesValue, cashValue]);
  ```
- **Causa raíz:** Se omitió `repos.cashGeneral.getBalance()`. Además, al
  filtrar `cashPmIds` por `type === 'cash'`, se ignora la columna canónica
  `isPhysicalCash` (usada en todo el resto del sistema). Si un medio de pago
  tiene `type='cash'` pero `isPhysicalCash=false` (caso teórico raro) o
  viceversa, hay incoherencia con `closeRegister` / `buildReport`.
- **Propuesta de fix:**
  ```ts
  // 1) Filtrar por isPhysicalCash (consistente con closeRegister/buildReport).
  const cashPmIds = new Set(allPms.filter((p) => p.isPhysicalCash).map((p) => p.id));

  // 2) Incluir Caja General.
  const generalBalance = await this.ctx.repos.cashGeneral.getBalance();
  const cashTotal = sumDecimals([cashValue, generalBalance]);
  const assetsTotal = sumDecimals([articlesValue, cashTotal]);

  return {
    ...
    assets: {
      articlesValue,
      cashValue: cashTotal,
      // (opcional) desglose:
      cashRegistersValue: cashValue,
      cashGeneralValue: generalBalance,
      total: assetsTotal,
    },
    ...
  };
  ```
- **Test que faltaba:** "Crear movimientos en Caja General y verificar que
  `getFinancialSummary().assets.cashValue` los refleja". Hoy no existe.

---

### HIGH

#### BUG-S03: Falta atomicidad entre `createSale`/`createPurchase` y la apertura de cuenta corriente

- **Síntoma:** En venta/compra a cuenta corriente, la cabecera se inserta
  dentro de una transacción (`sale.repository.createWithLines`), pero la
  `accountsReceivable.create` corre **fuera** de esa transacción, en el
  servicio. Si el proceso crashea (luz, kill, OOM), la venta queda
  `isAccountSale=true, status='completed'` SIN AR asociada → el cliente
  parece haber pagado, no hay deuda, no aparece en estado de cuenta.
  La diferencia se ve en reportes: "Deuda total clientes" no incluye esta
  venta, pero la venta aparece en libro IVA y en facturación.
- **Archivo:** `packages/core/src/services/sales.service.ts:174-193` y
  `packages/core/src/services/purchases.service.ts:125-157`.
- **Código actual:**
  ```ts
  // sales.service.ts:174
  const { sale, lines: savedLines, payments: savedPayments } = await repos.sales.createWithLines({...});

  let accountReceivable: AccountReceivable | null = null;
  if (isAccountSale) {
    accountReceivable = await repos.accountsReceivable.create({
      customerId: customer.id,
      saleId: sale.id,
      total: sale.total,
    });
  }
  ```
- **Causa raíz:** El repo expone `createWithLines` y `accountsReceivable.create`
  como métodos separados; el servicio no los une.
- **Propuesta de fix:** Mover la creación de AR/AP **dentro** de
  `sale.repository.createWithLines` (y `purchase.repository.createWithLines`).
  Pasar `isAccountSale` ya viaja, sólo agregar `customerId` y la inserción
  en la misma `tx`:
  ```ts
  // en sale.repository.createWithLines, después del insert de sales:
  if (data.isAccountSale) {
    tx.insert(accountsReceivable).values({
      customerId: data.customerId,
      saleId: insertedSale.id,
      total: insertedSale.total,
      balance: insertedSale.total,
      status: 'open',
    }).run();
  }
  ```
- **Test que faltaba:** "Forzar crash entre sale insert y AR insert → verificar
  invariante: toda venta `isAccountSale=true` tiene AR".

---

#### BUG-S04: `voidSale` no revierte movimientos de caja con `paymentMethodId=NULL` (legacy)

- **Síntoma:** Si por cualquier motivo (datos migrados, edge case) un
  `sale_payment` tiene `paymentMethodId = NULL`, al anular la venta NO se
  emite el reverso de caja, pero `closeRegister` y `buildReport` SÍ
  consideran ese ingreso como efectivo físico. Resultado: la caja queda
  "sobrante" después de anular.
- **Archivo:** `packages/db/src/repositories/sale.repository.ts:285-301`.
- **Código actual:**
  ```ts
  const cashBack = sumDecimals(sps.filter((s) => s.isCash === true).map((s) => s.amount));
  const cashPmId = sps.find((s) => s.isCash === true)?.pmId ?? null;
  if (!sale.isAccountSale && cashPmId && Number(cashBack) > 0) {
    tx.insert(cashMovements).values({ ...type: 'expense'..., amount: cashBack, paymentMethodId: cashPmId });
  }
  ```
- **Causa raíz:** El filtro es `s.isCash === true`. En el resto del sistema
  (`closeRegister`, `buildReport`), un movimiento con `paymentMethodId=NULL`
  cuenta como efectivo físico. Falta el OR `|| s.pmId == null`.
  Adicionalmente: si la venta tuvo **dos** pagos físicos con distintos
  `paymentMethodId` (raro pero posible), `cashPmId` toma sólo el primero y
  emite un único reverso lumped.
- **Propuesta de fix:** Replicar el patrón de `purchase.repository.voidPurchase`:
  filtrar `s.pmId == null || s.isCash === true`. E **idealmente** emitir un
  reverso por cada pago físico, no uno solo lumped.
- **Test que faltaba:** "Venta con 2 pagos físicos en distinto PM → anular →
  verificar que se emiten 2 reversos".

---

#### BUG-S05: `voidPurchase` lumpea reversos múltiples y puede dejar `paymentMethodId` colgando

- **Síntoma:** Análogo a S04 pero en compras: si la compra tuvo varios
  egresos físicos con distintos PM, el reverso es **uno solo** con la suma,
  asignado al PM del primer egreso encontrado. Si todos los egresos
  originales fueron legacy (NULL), `cashBack > 0` pero `cashPmId = null`
  → se inserta el reverso con PM=null. Funciona, pero rompe el desglose
  por medio de pago del `byPaymentMethod`.
- **Archivo:** `packages/db/src/repositories/purchase.repository.ts:241-275`.
- **Propuesta de fix:** Emitir un reverso por cada egreso físico original,
  preservando `paymentMethodId` y `amount` originales.

---

#### BUG-S06: Inconsistencia "deuda de cuenta" — `getTotalBalance(customer)` suma TODAS las cuentas, no sólo las no-saldadas

- **Síntoma:** El chequeo de límite de crédito en `sales.service.ts:163-170`
  llama a `repos.accountsReceivable.getTotalBalance(customer.id)`. Mirando el
  repo, ese método suma `balance` de **todas** las cuentas del cliente
  (incluidas `paid` → balance 0). Eso está bien para `getTotalBalance` per se
  (balance=0 en pagadas suma 0). PERO en `listBalances()` se filtra por
  `status != 'paid'`, y en `getTotalReceivables()` se suma `findAll()` sin
  filtro. Si por bug histórico una cuenta quedó `status='paid'` pero
  `balance != 0` (o viceversa), la cifra "deuda total" de la home y la
  cifra del estado de cuenta del cliente divergen.
- **Archivo:** `packages/db/src/repositories/accountsReceivable.repository.ts:72-83`
  vs `:89-111` vs `accountsReceivable.service.ts:178-181`.
- **Causa raíz:** No hay invariante `(status='paid') ⇔ (balance=0)` enforced
  por DB constraint. La única lógica que lo mantiene es `payment.repository.createPayment:122-128`,
  pero si se editan saldos manualmente o si hay rollback parcial (ver BUG-S03)
  pueden divergir.
- **Propuesta de fix:**
  - Unificar: `getTotalReceivables` debería usar el mismo filtro que
    `listBalances` (`status != 'paid'`) **o** la suma directa de balances no nulos.
  - Agregar test invariante: `assert ∀ ar: ar.status='paid' ⇔ ar.balance==0`.
  - Opcional: SQLite CHECK constraint sobre la tabla.

---

#### BUG-S07: `getFinancialSummary.cashValue` filtra `type === 'cash'` en lugar de `isPhysicalCash`

- **Síntoma:** Si algún medio de pago tiene `type='cash'` pero `isPhysicalCash=false`
  (o al revés), el resumen contable diverge del arqueo de caja diaria. Hoy
  ambos coinciden en la seed, pero al editar PMs desde Configuración el
  usuario puede romper esto.
- **Archivo:** `packages/core/src/services/accounting.service.ts:98`.
- **Propuesta de fix:** Usar `p.isPhysicalCash` (igual que `closeRegister`,
  `buildReport`, `voidSale`, `voidPurchase`). Ver fix conjunto en BUG-S02.

---

### MEDIUM

#### BUG-S08: `vatBucketKey` ignora alícuotas no estándar → libro IVA descuadra contra "vatAmount" del resumen

- **Síntoma:** En Argentina hay también alícuotas 2.5% y 5%. Si una línea
  tiene `vatRate='5.00'`, en el Libro IVA no se suma a ninguna columna
  (vat21/vat105/vat27), pero `salesVat` del resumen financiero SÍ acumula
  esa parte vía `vatBreakdown`. → Total VAT del resumen ≠ suma de columnas
  del libro IVA.
- **Archivo:** `packages/core/src/services/accounting.service.ts:58-64`.
- **Propuesta de fix:** Agregar columnas dinámicas por alícuota encontrada,
  o al menos una columna `vatOther` que capture las demás.

---

#### BUG-S09: Aritmética decimal basada en `Number` + `toFixed` — acumulación de centavos

- **Síntoma:** `packages/shared/src/utils/decimal.ts` documenta esto como
  TODO. Para un PDV chico es aceptable. Pero `sumDecimals` reduce con
  `acc + Number(v)` sin redondeo intermedio. Acumulando 1000 movimientos
  con valores como `0.10`, `0.20`, `0.30` pueden aparecer diferencias de
  1-3 centavos en `expectedCash` vs lo que ve el cajero sumando con
  calculadora. Esto es **exactamente el síntoma "diferencia chica
  inexplicable al cerrar caja"** que muchos usuarios reportan.
- **Archivo:** `packages/shared/src/utils/decimal.ts:29-60`.
- **Propuesta de fix:** Migrar a `big.js` o `decimal.js` (ya está marcado
  como TODO en el header del archivo). Reemplazar `Number(...)+Number(...)`
  por `new Big(a).plus(b).toFixed(decimals)`.
- **Impacto:** No es la causa de "diferencias grandes" (eso son S01/S02/S03)
  pero sí del ruido de centavos persistente.

---

#### BUG-S10: `transferFromDaily` exige `close_cash` pero opera sin chequear que la caja exista o esté en un estado válido

- **Síntoma:** El servicio recibe `cashRegisterId`, lo guarda como
  `referenceId`, pero nunca valida que el registerId exista ni que esté
  cerrado/abierto/en cualquier estado. Un cliente IPC mal formado puede
  pasar un UUID inventado y el balance general se infla con `referenceId`
  inválido.
- **Archivo:** `packages/core/src/services/cashGeneral.service.ts:115-128`.
- **Propuesta de fix:** Combinar con el fix de BUG-S01 (validar estado de
  la caja antes de transferir).

---

#### BUG-S11: `purchase.repository.createWithLines` — fallback legacy crea egreso con `paymentMethodId=NULL`

- **Síntoma:** Si `paymentsIn.length === 0` y `paymentType === 'cash'`
  (situación que el servicio actual no genera, pero técnicamente posible
  vía IPC raw), inserta un `cash_movements` SIN `paymentMethodId`. Por la
  convención del sistema (NULL = efectivo físico), el arqueo lo cuenta,
  pero el desglose `byPaymentMethod` lo agrupa bajo "Efectivo (sin asignar)"
  → confuso en el reporte.
- **Archivo:** `packages/db/src/repositories/purchase.repository.ts:191-205`.
- **Propuesta de fix:** Eliminar la rama legacy o forzar resolución a PM
  "Efectivo" por defecto.

---

### LOW

#### BUG-S12: `cmpDecimal(paid, total) !== 0` puede rechazar pagos válidos por floating point

- **Síntoma:** Splits que en papel suman exactamente el total pueden fallar
  por error de 1 ULP en `Number` (ej: 0.1 + 0.2 = 0.30000000000000004).
  Hoy `cmpDecimal` compara con `<` y `>` directos. Para totales típicos
  no se dispara, pero con muchos splits o decimales raros puede aparecer.
- **Archivo:** `packages/shared/src/utils/decimal.ts:44-50`.
- **Propuesta de fix:** Comparar con tolerancia: `Math.abs(na-nb) < 1e-4`
  como "igual" (o, mejor, migrar a big.js).

---

#### BUG-S13: `findStatusesByIds` para enriquecer movimientos sólo trae status de venta, no de compra

- **Síntoma:** En `buildReport`, `relatedSaleStatus` se asigna sólo para
  movimientos con `relatedSaleId`. Para `relatedPurchaseId` no se trae el
  status; un movimiento de compra anulada se sigue mostrando "normal" en
  el detalle de la caja, aunque el reverso esté presente. No afecta dinero,
  sí confunde al usuario.
- **Archivo:** `packages/core/src/services/cash.service.ts:267-274`.
- **Propuesta de fix:** Agregar `purchaseStatuses` análogo y enriquecer
  movimientos de compra.

---

## FLOWS REVISADOS (matriz)

| # | Flow | Estado | Bugs |
|---|------|--------|------|
| 1 | Apertura caja | OK | — (openingAmount string, default '0.0000', validado por Zod) |
| 2 | Cierre caja (diferencia) | OK | usa `subDecimal(closing, expected, 4)`; filtra por `isPhysicalCash OR pmId IS NULL` correctamente |
| 3 | `closeRegister` expectedAmount | OK | sólo movimientos físicos; correcto |
| 4 | `buildReport` byPaymentMethod | OK | usa `addDecimal/subDecimal` consistentes |
| 5 | `getHistoricalCashReport` | OK | delega en `buildReport` (mismo cálculo) |
| 6 | `listHistoricalCashRegisters` | OK | replica `closeRegister` (mismo filtro físico) |
| 7 | Venta → cash_movements por split | OK | un movement por split, con `paymentMethodId` correcto. Transfer/QR NO afectan arqueo físico (sólo los `isPhysicalCash`) |
| 8 | Venta a cuenta corriente | **BUG-S03** | atomicidad rota entre sale y AR |
| 9 | Compra contado → expense | OK | un expense por split, transfer/etc no afectan arqueo |
| 10 | Compra a cuenta proveedor | **BUG-S03** | atomicidad rota entre purchase y AP |
| 11 | Cobranza cuenta corriente | OK | atómica (sale → AR balance → cash_movement) |
| 12 | Pago a proveedor | OK | atómica análoga |
| 13 | `voidSale` reverso de caja | **BUG-S04** | NULL pmId legacy ignorado; lumpea multi-PM |
| 14 | `voidPurchase` reverso de caja | **BUG-S05** | lumpea multi-PM |
| 15 | Anulación post-cierre (cash diaria cerrada) | **OK por diseño** | sale.status='voided' pero el closingAmount queda fijo (intencional, no se toca caja cerrada) |
| 16 | Caja General `addMovement` (race) | OK | dentro de `tx`; SQLite serializa writes |
| 17 | **`transferFromDaily`** | **BUG-S01** | falta expense en la caja diaria origen |
| 18 | `getFinancialSummary.cashValue` | **BUG-S02 + S07** | falta Caja General; filtro por `type` en vez de `isPhysicalCash` |
| 19 | `getFinancialSummary.sales/cmv` | OK | filtra `status==='completed'` |
| 20 | `getVatBookSales`/`Purchases` | **BUG-S08** | bucket de IVA fijo (21/10.5/27); no contempla 2.5/5/0 |
| 21 | Total `vatAmount` resumen vs libro IVA | **BUG-S08** | descuadran si hay alícuotas no estándar |
| 22 | Aritmética decimal (`Number` + `toFixed`) | **BUG-S09** | acumulación de centavos en flows largos |
| 23 | Validación de pagos `cmpDecimal != 0` | **BUG-S12** | floating point puede rechazar splits válidos |
| 24 | Listados deuda clientes/proveedores | **BUG-S06** | divergencia potencial entre `getTotalReceivables` y `listBalances` |
| 25 | Caja General → balance vs sum(movements) | OK | `balanceAfter` se calcula dentro de tx con lectura previa; consistente |

---

## RECOMENDACIONES DE FIX PRIORIZADAS

1. **BUG-S01 (BLOCKER)** — fixear `transferFromDaily` para que descuente la
   caja diaria. Mover el flujo a "transferir ANTES de cerrar" (UX más limpia)
   o registrar contrapartida automática en la caja diaria. Si el cliente ya
   transfirió decenas de veces sin contrapartida, hay que **migrar** los
   históricos: por cada `cash_general_movements WHERE type='transfer_from_daily'`
   insertar el `cash_movements` faltante en la caja referenciada.
2. **BUG-S02 (BLOCKER)** — incluir `cashGeneral.getBalance()` en
   `getFinancialSummary.cashValue`. Idealmente desglosar en `cashRegistersValue`
   + `cashGeneralValue` para que el cliente entienda el desglose.
3. **BUG-S03 (HIGH)** — mover la creación de AR/AP DENTRO de la transacción
   atómica de `sale.repository.createWithLines` y `purchase.repository.createWithLines`.
   Agregar un script `repair:account-sales` que detecte ventas
   `isAccountSale=true` sin AR y las repare (crear AR con `total=sale.total,
   balance=sale.total`).
4. **BUG-S07 (HIGH)** — cambiar el filtro de "efectivo físico" en accounting
   por `isPhysicalCash` (canónico).
5. **BUG-S06 (HIGH)** — unificar criterios entre `getTotalReceivables`,
   `listBalances` y `getTotalBalance`. Agregar test invariante.
6. **BUG-S04 + BUG-S05 (HIGH)** — homogeneizar los `void*`: incluir NULL pmId
   como físico (S04), y emitir un reverso por cada egreso/ingreso original
   en lugar de lumpear (S05).
7. **BUG-S08 (MEDIUM)** — soportar alícuotas no estándar en Libro IVA o al
   menos columna "otras".
8. **BUG-S09 + BUG-S12 (MEDIUM)** — migrar `decimal.ts` a `big.js`. Elimina
   las diferencias de centavos en flows largos y los falsos rechazos de
   splits válidos.
9. **BUG-S10 (MEDIUM)** — validar `cashRegisterId` en `transferFromDaily`
   (se resuelve junto con S01).
10. **BUG-S11 + BUG-S13 (LOW)** — limpiar caminos legacy + enriquecer detalle
    de movimientos con status de compra.

---

## QUERIES DE DIAGNÓSTICO (para correr en el SQLite del cliente)

```sql
-- 1) Ventas a cuenta sin AR (BUG-S03):
SELECT s.id, s.number, s.type, s.total, s.date
FROM sales s
LEFT JOIN accounts_receivable ar ON ar.sale_id = s.id
WHERE s.is_account_sale = 1 AND ar.id IS NULL;

-- 2) Compras a cuenta sin AP (BUG-S03):
SELECT p.id, p.number, p.type, p.total
FROM purchases p
LEFT JOIN supplier_accounts_payable ap ON ap.purchase_id = p.id
WHERE p.payment_type = 'credit' AND ap.id IS NULL;

-- 3) AR con status incoherente vs balance (BUG-S06):
SELECT id, status, total, balance
FROM accounts_receivable
WHERE (status = 'paid' AND CAST(balance AS REAL) != 0)
   OR (status != 'paid' AND CAST(balance AS REAL) = 0);

-- 4) Transferencias a Caja General sin contrapartida en caja diaria (BUG-S01):
SELECT cgm.id, cgm.amount, cgm.reference_id AS cash_register_id, cgm.created_at
FROM cash_general_movements cgm
WHERE cgm.type = 'transfer_from_daily'
  AND NOT EXISTS (
    SELECT 1 FROM cash_movements cm
    WHERE cm.cash_register_id = cgm.reference_id
      AND cm.type = 'expense'
      AND cm.description LIKE '%Caja General%'
      AND ABS(CAST(cm.amount AS REAL) - CAST(cgm.amount AS REAL)) < 0.01
  );

-- 5) Diferencia total acumulada por S01:
SELECT printf('%.2f', SUM(CAST(amount AS REAL))) AS posible_duplicado
FROM cash_general_movements
WHERE type = 'transfer_from_daily';
```

Correr (1)-(5) en la DB del cliente da una estimación del impacto monetario
real y permite priorizar la migración de datos antes del fix de código.
