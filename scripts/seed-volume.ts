/**
 * scripts/seed-volume.ts — Seeder de VOLUMEN + auditoría E2E (solo lectura sobre
 * el código de la app: NO importa ni modifica lógica, solo la USA via los
 * servicios/repos públicos).
 *
 * Genera ~1 mes de operación realista en una DB **temporal aislada** (os.tmpdir),
 * NUNCA la del cliente, y audita cálculos / integridad / performance comparando
 * lo que reporta el sistema contra sumas manuales y contra cruces system-vs-system.
 *
 * Correr (better-sqlite3 debe estar compilado para el Node actual):
 *   apps/desktop/node_modules/.bin/tsx scripts/seed-volume.ts
 *
 * Imprime un reporte a stdout (que alimenta docs/AUDIT_E2E_VOLUMEN_*.md).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initLocalDb, createRepositories, closeLocalDb } from '../packages/db/src/index'
import { createServices, createServiceContext, AuthService } from '../packages/core/src/index'

/* ----------------------------- utilidades ------------------------------ */
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260618)
const ri = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1))
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!
const money = (n: number): string => n.toFixed(4)
const qty = (n: number): string => n.toFixed(3)
const N = (s: string | number | null | undefined): number => Number(s ?? 0)
const near = (a: number | string, b: number | string, tol = 0.01): boolean => Math.abs(N(a) - N(b)) <= tol

type Sev = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW'
const findings: { id: string; sev: Sev; area: string; desc: string; expected: string; got: string }[] = []
const okChecks: string[] = []
let bugN = 0
function bug(sev: Sev, area: string, desc: string, expected: unknown, got: unknown): void {
  findings.push({ id: `BUG-E2E-${String(++bugN).padStart(2, '0')}`, sev, area, desc, expected: String(expected), got: String(got) })
  console.log(`  ✗ [${sev}] ${area}: ${desc} — esperado=${String(expected)} obtenido=${String(got)}`)
}
function checkEq(area: string, desc: string, expected: unknown, got: unknown, sev: Sev = 'HIGH', tol = 0.01): void {
  if (near(expected as number, got as number, tol)) {
    okChecks.push(`${area}: ${desc}`)
    console.log(`  ✓ ${area}: ${desc} (=${String(got)})`)
  } else bug(sev, area, desc, expected, got)
}
function checkTrue(area: string, desc: string, cond: boolean, sev: Sev = 'HIGH', detail = ''): void {
  if (cond) { okChecks.push(`${area}: ${desc}`); console.log(`  ✓ ${area}: ${desc}`) }
  else bug(sev, area, desc, 'true', `false ${detail}`)
}

/** CUIT válido (con dígito verificador) a partir de un DNI de 8 dígitos. */
function cuit(dni8: string): string {
  const body = '20' + dni8
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let s = 0
  for (let i = 0; i < 10; i++) s += Number(body[i]) * w[i]!
  let c = 11 - (s % 11)
  if (c === 11) c = 0
  if (c === 10) c = 9
  return `20-${dni8}-${c}`
}

const PM = { cash: 'pm-efectivo', debit: 'pm-tarjeta-debito', credit: 'pm-tarjeta-credito', transfer: 'pm-transferencia' }

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'stockflow-seed-volume-'))
  const dbPath = join(dir, 'stockflow.db')
  console.log(`\n=== SEEDER DE VOLUMEN — DB temporal aislada: ${dbPath} ===\n`)
  const { db } = initLocalDb(dbPath)
  const repos = createRepositories(db)
  const auth = new AuthService(repos)
  const { user: admin } = await auth.login('admin', 'admin')
  const A = createServices(createServiceContext(db, admin))

  /* ----------------------------- datos base ---------------------------- */
  const cajero1 = await repos.users.create({ username: 'cajero1', password: '1234', fullName: 'Cajero Uno', role: 'seller' })
  const cajero2 = await repos.users.create({ username: 'cajero2', password: '1234', fullName: 'Cajero Dos', role: 'seller' })
  const sellers = [cajero1, cajero2].map((u) => ({ u, S: createServices(createServiceContext(db, u)) }))

  const famNames = ['Bebidas', 'Almacén', 'Limpieza', 'Golosinas', 'Fiambres', 'Bazar']
  const fams = []
  for (const n of famNames) fams.push(await repos.families.create({ name: n }))

  const sups = []
  for (let i = 1; i <= 10; i++) sups.push(await repos.suppliers.create({ code: `P${String(i).padStart(3, '0')}`, name: `Proveedor ${i}` }))

  // 40 artículos: códigos cortos (1..5) + EAN13, lista 1/2/3, costos/márgenes varios,
  // stock alto/bajo/0, algunos por peso, IVA 21/10.5/0. Precios en pesos ENTEROS
  // (evita mismatch de redondeo en pagos exactos; AR usa precios enteros igual).
  const vats = ['21.00', '21.00', '21.00', '10.50', '0.00']
  const arts: { id: string; vatRate: string; listPrice1: number; costPrice: number; byWeight: boolean }[] = []
  const initialStock = new Map<string, number>()
  const soldQty = new Map<string, number>()
  const boughtQty = new Map<string, number>()
  for (let i = 0; i < 40; i++) {
    const cost = ri(50, 5000)
    const lp1 = Math.round(cost * (1 + ri(20, 80) / 100))
    const code = i < 5 ? String(i + 1) : `779${String(1000000000 + i * 7).slice(0, 10)}`
    const stock = i % 7 === 0 ? 0 : ri(0, 200)
    const byWeight = i % 9 === 0
    const vatRate = pick(vats)
    const a = await repos.articles.create({
      barcode: code,
      description: `${famNames[i % famNames.length]} producto ${i + 1}`,
      familyId: pick(fams).id,
      supplierId: pick(sups).id,
      costPrice: money(cost),
      listPrice1: money(lp1),
      listPrice2: money(Math.round(lp1 * 1.1)),
      listPrice3: money(Math.round(lp1 * 1.2)),
      vatRate,
      stock: qty(stock),
      minStock: qty(ri(5, 20)),
      idealStock: qty(ri(30, 60)),
      soldByWeight: byWeight,
      unit: byWeight ? 'KG' : 'UN',
    })
    arts.push({ id: a.id, vatRate, listPrice1: lp1, costPrice: cost, byWeight })
    initialStock.set(a.id, stock); soldQty.set(a.id, 0); boughtQty.set(a.id, 0)
  }

  // 40 clientes: CF (seed) + 39. ~1/3 RI con CUIT válido; resto CF/DNI (igual
  // elegibles para cuenta corriente por tener docType≠CF + docNumber).
  const cf = (await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' }))!
  const accountCustomers: string[] = []
  const riCustomers: string[] = []
  for (let i = 1; i < 40; i++) {
    const isRI = i % 3 === 0
    const dni8 = String(20000000 + i * 531).slice(0, 8)
    const c = await repos.customers.create({
      lastName: `CLIENTE${i}`,
      firstName: pick(['Juan', 'Ana', 'Luis', 'Marta', 'Pedro']),
      category: isRI ? 'RI' : 'CF',
      docType: isRI ? 'CUIT' : 'DNI',
      docNumber: isRI ? cuit(dni8) : dni8,
      creditLimit: money(0),
    })
    accountCustomers.push(c.id)
    if (isRI) riCustomers.push(c.id)
  }

  /* --------------------- movimientos: ~30 días ------------------------- */
  // Tracking liviano para auditar contra el sistema.
  let salesCount = 0, voidCount = 0, purchaseCount = 0
  let manualSalesTotalCompleted = 0 // suma de totales de ventas NO anuladas
  let manualSalesVatCompleted = 0
  const openARByCustomer = new Map<string, number>() // saldo cuenta corriente esperado
  const openAPBySupplier = new Map<string, number>()
  let manualGeneralBalance = 0
  const arAccounts: { accountId: string; customerId: string; balance: number }[] = []
  const apAccounts: { accountId: string; supplierId: string; balance: number }[] = []
  let priceUpdateBatches = 0

  for (let day = 0; day < 30; day++) {
    const isWeekend = day % 7 === 5 || day % 7 === 6
    const { u: seller, S } = sellers[day % 2]!
    let reg
    try {
      reg = await S.cash.openCashRegister(money(ri(2000, 8000)))
    } catch {
      const cur = await repos.cashRegisters.getCurrentOpen()
      if (!cur) throw new Error('no se pudo abrir ni recuperar la caja')
      reg = cur
    }

    const salesToday = isWeekend ? ri(14, 22) : ri(6, 12)
    for (let s = 0; s < salesToday; s++) {
      const nItems = ri(1, 15)
      const lines: { articleId: string; quantity: string; unitPrice: string }[] = []
      let total = 0
      const usedVat = new Set<string>()
      for (let it = 0; it < nItems; it++) {
        const a = pick(arts)
        const q = a.byWeight ? ri(1, 3) : ri(1, 5) // enteros → totales exactos
        const up = a.listPrice1
        lines.push({ articleId: a.id, quantity: qty(q), unitPrice: money(up) })
        total += q * up
        soldQty.set(a.id, soldQty.get(a.id)! + q)
        usedVat.add(a.vatRate)
      }
      const roll = rnd()
      const account = roll < 0.03 && accountCustomers.length > 0
      try {
        if (account) {
          const custId = pick(accountCustomers)
          const r = await S.sales.createSale({ type: 'B', customerId: custId, isAccountSale: true, lines })
          salesCount++
          if (r.accountReceivable) {
            arAccounts.push({ accountId: r.accountReceivable.id, customerId: custId, balance: N(r.accountReceivable.balance) })
            openARByCustomer.set(custId, (openARByCustomer.get(custId) ?? 0) + N(r.sale.total))
          }
          manualSalesTotalCompleted += N(r.sale.total)
          manualSalesVatCompleted += N(r.sale.vatAmount)
        } else {
          // descuento ocasional (entero)
          const discount = rnd() < 0.15 ? ri(1, Math.max(1, Math.floor(total * 0.05))) : 0
          const payTotal = total - discount
          let payments: { paymentMethodId: string; amount: string }[]
          if (rnd() < 0.2) {
            // split en 2
            const a1 = Math.floor(payTotal / 2)
            payments = [
              { paymentMethodId: PM.cash, amount: money(a1) },
              { paymentMethodId: PM.transfer, amount: money(payTotal - a1) },
            ]
          } else {
            const pmRoll = rnd()
            const pm = pmRoll < 0.6 ? PM.cash : pmRoll < 0.8 ? PM.debit : pmRoll < 0.9 ? PM.credit : PM.transfer
            payments = [{ paymentMethodId: pm, amount: money(payTotal) }]
          }
          const r = await S.sales.createSale({ type: 'B', customerId: cf.id, payments, discount: money(discount), lines })
          salesCount++
          // ~5% anuladas (dentro del día, caja abierta) por admin
          if (rnd() < 0.05) {
            await A.sales.voidSale(r.sale.id)
            voidCount++
            // revertir tracking de stock vendido
            for (const l of lines) soldQty.set(l.articleId, soldQty.get(l.articleId)! - N(l.quantity))
          } else {
            manualSalesTotalCompleted += N(r.sale.total)
            manualSalesVatCompleted += N(r.sale.vatAmount)
          }
        }
      } catch (e) {
        console.log(`  ⚠ venta falló (día ${day}): ${(e as Error).message}`)
      }
    }

    // compras (~2/día → ~60)
    for (let p = 0; p < ri(1, 3); p++) {
      const sup = pick(sups)
      const nItems = ri(1, 5)
      const plines: { articleId: string; quantity: string; costPrice: string; vatRate: string }[] = []
      let ptotal = 0
      for (let it = 0; it < nItems; it++) {
        const a = pick(arts)
        const q = ri(5, 30)
        const cp = a.costPrice
        plines.push({ articleId: a.id, quantity: qty(q), costPrice: money(cp), vatRate: a.vatRate })
        ptotal += q * cp
        boughtQty.set(a.id, boughtQty.get(a.id)! + q)
      }
      try {
        if (rnd() < 0.4) {
          const r = await A.purchases.createPurchase({ type: 'A', supplierId: sup.id, isAccountPurchase: true, lines: plines })
          purchaseCount++
          if (r.accountPayable) {
            apAccounts.push({ accountId: r.accountPayable.id, supplierId: sup.id, balance: N(r.accountPayable.balance) })
            openAPBySupplier.set(sup.id, (openAPBySupplier.get(sup.id) ?? 0) + N(r.purchase.total))
          }
        } else {
          await A.purchases.createPurchase({
            type: 'A', supplierId: sup.id,
            payments: [{ paymentMethodId: PM.cash, amount: money(ptotal) }],
            updatePrices: rnd() < 0.3,
            lines: plines,
          })
          purchaseCount++
        }
      } catch (e) {
        console.log(`  ⚠ compra falló (día ${day}): ${(e as Error).message}`)
      }
    }

    // movimientos manuales de caja
    if (rnd() < 0.5) {
      try { await A.cash.addMovement({ type: 'income', description: 'Ingreso vario', amount: money(ri(100, 2000)), paymentMethodId: PM.cash }) } catch { /* */ }
    }
    if (rnd() < 0.5) {
      try { await A.cash.addMovement({ type: 'expense', description: 'Gasto vario', amount: money(ri(100, 2000)), paymentMethodId: PM.cash }) } catch { /* */ }
    }

    // cobro de cuenta corriente (cliente paga deuda)
    if (arAccounts.length > 0 && rnd() < 0.5) {
      const acc = arAccounts.find((a) => a.balance > 0)
      if (acc) {
        const payAmt = Math.max(1, Math.floor(acc.balance * (rnd() < 0.5 ? 1 : 0.5)))
        try {
          await S.accountsReceivable.receivePayment({ accountId: acc.accountId, payments: [{ paymentMethodId: PM.cash, amount: money(payAmt) }] })
          acc.balance -= payAmt
          openARByCustomer.set(acc.customerId, (openARByCustomer.get(acc.customerId) ?? 0) - payAmt)
        } catch (e) { console.log(`  ⚠ cobro AR falló: ${(e as Error).message}`) }
      }
    }

    // pago a proveedor
    if (apAccounts.length > 0 && rnd() < 0.5) {
      const acc = apAccounts.find((a) => a.balance > 0)
      if (acc) {
        const payAmt = Math.max(1, Math.floor(acc.balance * 0.5))
        try {
          await A.supplierAccounts.payInvoice({ accountId: acc.accountId, payments: [{ paymentMethodId: PM.cash, amount: money(payAmt) }] })
          acc.balance -= payAmt
          openAPBySupplier.set(acc.supplierId, (openAPBySupplier.get(acc.supplierId) ?? 0) - payAmt)
        } catch (e) { console.log(`  ⚠ pago AP falló: ${(e as Error).message}`) }
      }
    }

    // transferencia a Caja General (algunos días)
    if (rnd() < 0.4) {
      try {
        const rep = await S.cash.getCashReport(reg.id)
        const avail = N(rep.expectedCash)
        if (avail > 1000) {
          const amt = Math.floor(avail * 0.3)
          await A.cashGeneral.transferFromDaily({ cashRegisterId: reg.id, amount: money(amt) })
          manualGeneralBalance += amt
        }
      } catch (e) { console.log(`  ⚠ transfer general falló: ${(e as Error).message}`) }
    }

    // actualizaciones masivas de precios (3 veces en el mes)
    if ((day === 9 || day === 19 || day === 29) && priceUpdateBatches < 3) {
      try {
        await A.priceUpdates.applyUpdate({
          filter: { scope: 'all' },
          rule: { type: 'percentage', value: '10', direction: 'increase', fields: ['listPrice1', 'listPrice2', 'listPrice3'] },
          description: `Inflación +10% (lote ${priceUpdateBatches + 1})`,
        })
        priceUpdateBatches++
      } catch (e) { console.log(`  ⚠ price update falló: ${(e as Error).message}`) }
    }

    // cierre de caja con arqueo (mayoría exacto; ~3 con diferencia)
    try {
      const rep = await S.cash.getCashReport(reg.id)
      const raw = day % 11 === 0 ? N(rep.expectedCash) + ri(-200, 200) : N(rep.expectedCash)
      const declared = Math.max(0, Math.round(raw))
      await A.cash.closeCashRegister(reg.id, money(declared), `cierre día ${day}`)
    } catch (e) { console.log(`  ⚠ cierre caja falló (día ${day}): ${(e as Error).message}`) }
  }

  console.log(`\n--- seed listo: ${salesCount} ventas (${voidCount} anuladas), ${purchaseCount} compras, ${priceUpdateBatches} lotes de precios ---\n`)
  console.log('=== AUDITORÍA ===\n')

  const now = Date.now()
  const from = 0, to = now + 86_400_000

  /* 3. VENTAS */
  console.log('[Ventas]')
  const salesRep = await A.reports.salesByDateRange(from, to)
  const completed = salesRep.sales.filter((s) => s.status === 'completed')
  const voided = salesRep.sales.filter((s) => s.status === 'voided')
  checkTrue('Ventas', `hay volumen (${salesRep.sales.length} ventas, >=300)`, salesRep.sales.length >= 300, 'MEDIUM', `count=${salesRep.sales.length}`)
  checkEq('Ventas', 'suma de totales NO anulados (sistema vs manual)', manualSalesTotalCompleted, completed.reduce((a, s) => a + N(s.total), 0), 'BLOCKER', 1)
  // consistencia por venta: subtotal/iva/total + anuladas no rompen
  let badTotal = 0
  for (const s of completed) {
    // gross: total = subtotal - discount ; vat contenido. Verificamos total>=0 y vat<=total.
    if (N(s.vatAmount) > N(s.total) + 0.01 || N(s.total) < 0) badTotal++
  }
  checkTrue('Ventas', 'todas las ventas: vatAmount<=total y total>=0', badTotal === 0, 'HIGH', `${badTotal} inconsistentes`)

  /* 4-5. CAJA + CAJA GENERAL */
  console.log('\n[Caja diaria]')
  const cajas = await A.cash.listHistoricalCashRegisters({ from, to })
  let cajaIncons = 0
  for (const c of cajas) {
    if (c.status !== 'closed') continue
    const rep = await A.cash.getHistoricalCashReport(c.id)
    // expectedCash debe = apertura + ingresos efectivo - egresos efectivo (neto del medio físico)
    const cashBd = rep.byPaymentMethod.find((b) => b.isPhysicalCash)
    const expected = N(rep.openingAmount) + N(cashBd?.net ?? '0')
    if (!near(expected, rep.expectedCash, 0.01)) { cajaIncons++; if (cajaIncons <= 3) bug('HIGH', 'Caja', `expectedCash != apertura + neto efectivo (caja ${c.id.slice(0, 8)})`, expected, rep.expectedCash) }
  }
  checkTrue('Caja', `cierre de cajas consistente (apertura+neto efectivo=expected) en ${cajas.length} cajas`, cajaIncons === 0)

  console.log('\n[Caja General]')
  const genBalance = await A.cashGeneral.getBalance()
  const genMovs = await A.cashGeneral.listMovements({})
  const genSum = genMovs.reduce((a, m) => a + (m.type === 'expense' ? -N(m.amount) : N(m.amount)), 0)
  checkEq('CajaGeneral', 'balance = suma de movimientos (sin dinero duplicado, bug S01)', genSum, genBalance, 'BLOCKER', 0.01)
  checkEq('CajaGeneral', 'balance >= transferencias trackeadas', manualGeneralBalance, genBalance, 'MEDIUM', genBalance) // informativo

  /* 6. CUENTAS CORRIENTES CLIENTES */
  console.log('\n[Cuentas corrientes — clientes]')
  const arBalances = await A.accountsReceivable.listCustomerBalances()
  const totalReceiv = await A.accountsReceivable.getTotalReceivables()
  const sumAR = arBalances.reduce((a, b) => a + N(b.totalDebt), 0)
  checkEq('AR', 'getTotalReceivables = suma de balances de clientes', sumAR, totalReceiv, 'HIGH', 0.01)
  // cruzar un par de clientes con el tracking manual
  let arIncons = 0
  for (const [custId, expected] of openARByCustomer) {
    if (expected <= 0.01) continue
    const sysBal = N(arBalances.find((b) => b.customerId === custId)?.totalDebt ?? '0')
    if (!near(expected, sysBal, 0.01)) { arIncons++; if (arIncons <= 3) bug('HIGH', 'AR', `saldo cliente ${custId.slice(0, 8)} (manual vs sistema)`, expected, sysBal) }
  }
  checkTrue('AR', 'saldos de clientes coinciden con el tracking manual', arIncons === 0)

  /* 7. CUENTAS CORRIENTES PROVEEDORES */
  console.log('\n[Cuentas corrientes — proveedores]')
  const apBalances = await A.supplierAccounts.listSupplierBalances()
  let apIncons = 0
  for (const [supId, expected] of openAPBySupplier) {
    if (expected <= 0.01) continue
    const sysBal = N(apBalances.find((b) => b.supplierId === supId)?.totalDebt ?? '0')
    if (!near(expected, sysBal, 0.01)) { apIncons++; if (apIncons <= 3) bug('HIGH', 'AP', `saldo proveedor ${supId.slice(0, 8)} (manual vs sistema)`, expected, sysBal) }
  }
  checkTrue('AP', 'saldos de proveedores coinciden con el tracking manual', apIncons === 0)

  /* 8. STOCK */
  console.log('\n[Stock / inventario]')
  let stockIncons = 0
  const sample = arts.slice(0, 15)
  for (const a of sample) {
    const cur = await repos.articles.findById(a.id)
    const expected = initialStock.get(a.id)! - soldQty.get(a.id)! + boughtQty.get(a.id)!
    if (!near(expected, N(cur!.stock), 0.001)) { stockIncons++; if (stockIncons <= 5) bug('HIGH', 'Stock', `stock art ${a.id.slice(0, 8)} (inicial-vendido+comprado vs sistema)`, expected, cur!.stock) }
  }
  checkTrue('Stock', `stock de ${sample.length} artículos = inicial - vendido + comprado`, stockIncons === 0, 'BLOCKER')

  /* 9. CONTABILIDAD */
  console.log('\n[Contabilidad]')
  const fin = await A.accounting.getFinancialSummary({ from, to })
  checkEq('Contab', 'ventas.total del summary = ventas NO anuladas del reporte', completed.reduce((a, s) => a + N(s.total), 0), fin.sales.total, 'HIGH', 1)
  checkEq('Contab', 'grossResult = ventas - CMV', N(fin.sales.total) - N(fin.cmv.total), fin.grossResult, 'HIGH', 1)
  checkEq('Contab', 'vatPosition = IVA débito (ventas) - IVA crédito (compras)', N(fin.sales.vatAmount) - N(fin.purchases.vatAmount), fin.vatPosition, 'HIGH', 1)
  checkEq('Contab', 'assets.total = stock@costo + cajas + caja general', N(fin.assets.articlesValue) + N(fin.assets.cashRegistersValue) + N(fin.assets.cashGeneralValue), fin.assets.total, 'HIGH', 1)
  checkTrue('Contab', 'valor de inventario (stock@costo) NO negativo', N(fin.assets.articlesValue) >= 0, 'MEDIUM', `articlesValue=${fin.assets.articlesValue}`)
  checkTrue('Contab', 'activos totales NO negativos', N(fin.assets.total) >= 0, 'MEDIUM', `assets.total=${fin.assets.total}`)

  /* 8b. LIBRO IVA */
  console.log('\n[Libro IVA]')
  const ivaSales = await A.accounting.getVatBookSales({ from, to })
  const ivaSalesActive = ivaSales.filter((r) => r.status !== 'voided')
  const ivaSalesVat = ivaSalesActive.reduce((a, r) => a + N(r.vat21) + N(r.vat105) + N(r.vat27), 0)
  checkEq('LibroIVA', 'suma IVA Libro Ventas (no anuladas) = IVA débito del summary', N(fin.sales.vatAmount), ivaSalesVat, 'MEDIUM', 2)

  /* 10. PRECIOS */
  console.log('\n[Actualización de precios]')
  const batches = await A.priceUpdates.listBatches({})
  checkTrue('Precios', `los 3 lotes de precios quedaron registrados`, batches.length >= 3, 'MEDIUM', `lotes=${batches.length}`)

  /* 11. PERFORMANCE */
  console.log('\n[Performance]')
  async function timed(label: string, fn: () => Promise<unknown>): Promise<void> {
    const t0 = Date.now(); await fn(); const ms = Date.now() - t0
    console.log(`  · ${label}: ${ms}ms`)
    if (ms > 1000) bug('MEDIUM', 'Performance', `${label} tarda > 1s con este volumen`, '<1000ms', `${ms}ms`)
    else okChecks.push(`Performance: ${label} ${ms}ms`)
  }
  await timed('listar artículos', () => repos.articles.findAll())
  await timed('historial de ventas (rango)', () => A.reports.salesByDateRange(from, to))
  await timed('dashboard analytics (top productos)', () => A.analytics.getTopSellingProducts({ from, to, limit: 10 }))
  await timed('resumen financiero (contabilidad)', () => A.accounting.getFinancialSummary({ from, to }))
  await timed('libro IVA ventas', () => A.accounting.getVatBookSales({ from, to }))
  await timed('búsqueda de artículos', () => repos.articles.searchByText('producto'))

  /* 13-14. INTEGRIDAD (SQL directo) */
  console.log('\n[Integridad referencial]')
  const sql = (db as unknown as { $client: { prepare: (q: string) => { get: () => { c: number } } } }).$client
  const orphanItems = sql.prepare(`SELECT COUNT(*) c FROM sale_lines WHERE article_id NOT IN (SELECT id FROM articles)`).get().c
  checkTrue('Integridad', 'sin sale_lines con article_id huérfano', orphanItems === 0, 'BLOCKER', `${orphanItems}`)
  const orphanPays = sql.prepare(`SELECT COUNT(*) c FROM sale_payments WHERE sale_id NOT IN (SELECT id FROM sales)`).get().c
  checkTrue('Integridad', 'sin sale_payments sin venta', orphanPays === 0, 'BLOCKER', `${orphanPays}`)
  const voidedWithPays = sql.prepare(`SELECT COUNT(*) c FROM sale_payments WHERE sale_id IN (SELECT id FROM sales WHERE status='voided')`).get().c
  checkTrue('Integridad', 'ventas anuladas no conservan sale_payments', voidedWithPays === 0, 'HIGH', `${voidedWithPays}`)
  const orphanMovs = sql.prepare(`SELECT COUNT(*) c FROM cash_movements WHERE cash_register_id IS NOT NULL AND cash_register_id NOT IN (SELECT id FROM cash_registers)`).get().c
  checkTrue('Integridad', 'sin movimientos de caja con caja inexistente', orphanMovs === 0, 'BLOCKER', `${orphanMovs}`)

  /* --------------------------- RESUMEN ------------------------------- */
  const bySev = (s: Sev): number => findings.filter((f) => f.sev === s).length
  console.log(`\n=== RESUMEN: ${findings.length} hallazgos — BLOCKER=${bySev('BLOCKER')} HIGH=${bySev('HIGH')} MEDIUM=${bySev('MEDIUM')} LOW=${bySev('LOW')} | ${okChecks.length} checks OK ===`)
  console.log('\n<<<AUDIT_JSON>>>')
  console.log(JSON.stringify({ findings, okChecks, stats: { salesCount, voidCount, purchaseCount, priceUpdateBatches, salesInReport: salesRep.sales.length, cajas: cajas.length } }))
  console.log('<<<END_AUDIT_JSON>>>')

  closeLocalDb(db)
}

main().catch((e) => { console.error('SEEDER FALLÓ:', e); process.exit(1) })
