import { and, desc, eq, gte, inArray, like, lt, lte, max, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  CreateSaleWithLinesSchema,
  type CreateSaleWithLinesInput,
  type PriceMode,
  type VoucherType,
  addDecimal,
  cmpDecimal,
  gteDecimal,
  mulDecimal,
  proratedVatBreakdown,
  subDecimal,
  sumDecimals,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  accountsReceivable,
  articles,
  cashMovements,
  cashRegisters,
  companies,
  paymentMethods,
  payments,
  promotionItems,
  promotions,
  returnLines,
  returns,
  saleLines,
  salePayments,
  sales,
  type AccountReceivable,
  type NewSaleLine,
  type Sale,
  type SaleLine,
  type SalePayment,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface SaleWithLines {
  sale: Sale;
  lines: SaleLine[];
  /** Pagos de la venta (vacío si es a cuenta corriente). */
  payments: SalePayment[];
  /** Cuenta corriente abierta (sólo si es venta a cuenta), null en otro caso. */
  accountReceivable: AccountReceivable | null;
}

/** Filtros de "Facturas emitidas" (Contabilidad). Todos opcionales: sin fechas = todas. */
export interface FiltroFacturasEmitidas {
  from?: number | null;
  to?: number | null;
  customerId?: string | null;
  type?: 'A' | 'B' | 'C' | 'X' | null;
  incluirAnuladas?: boolean;
}

function condicionesFacturasEmitidas(f: FiltroFacturasEmitidas): SQL[] {
  const conds: SQL[] = [];
  if (f.from != null) conds.push(gte(sales.date, f.from));
  if (f.to != null) conds.push(lte(sales.date, f.to));
  if (f.customerId) conds.push(eq(sales.customerId, f.customerId));
  if (f.type) conds.push(eq(sales.type, f.type));
  if (!f.incluirAnuladas) conds.push(ne(sales.status, 'voided'));
  return conds;
}

export class SaleRepository extends BaseRepository<Sale, typeof sales.$inferInsert> {
  constructor(db: LocalDatabase) {
    super(db, sales, 'Venta');
  }

  /** Próximo número de comprobante para un tipo dado (MAX(number) + 1). */
  async getNextNumber(type: VoucherType): Promise<number> {
    try {
      const row = this.db
        .select({ value: max(sales.number) })
        .from(sales)
        .where(eq(sales.type, type))
        .get();
      return (row?.value ?? 0) + 1;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Crea una venta de forma atómica: cabecera + líneas + descuento de stock +
   * pagos (sale_payments) + movimientos de caja (uno por pago; sólo los de
   * efectivo físico afectan el arqueo). Si `isAccountSale`, no lleva pagos y la
   * AR la abre el servicio. Lanza `ConstraintError` si falta stock o si la suma
   * de pagos no coincide con el total.
   */
  async createWithLines(rawData: unknown): Promise<SaleWithLines> {
    try {
      const data = this.parseOrThrow<CreateSaleWithLinesInput>(
        CreateSaleWithLinesSchema,
        rawData,
      );
      const now = data.date ?? Date.now();
      const saleDiscount = data.discount ?? '0.0000';
      const paymentsIn = data.payments ?? [];

      return this.db.transaction((tx) => {
        // Número de comprobante (dentro de la transacción para evitar carreras).
        const numRow = tx
          .select({ value: max(sales.number) })
          .from(sales)
          .where(eq(sales.type, data.type))
          .get();
        const number = (numRow?.value ?? 0) + 1;

        // Modo de precios vigente de la empresa: define cómo se calcula el IVA y el total.
        const cmpRow = tx
          .select({ priceMode: companies.priceMode, allowNegativeStock: companies.allowNegativeStock })
          .from(companies)
          .limit(1)
          .get();
        const priceMode: PriceMode = cmpRow?.priceMode === 'net' ? 'net' : 'gross';
        // Permitir vender sin stock (BUG-OP-01). Default false (bloquea) cuando
        // NO hay empresa configurada — en producción siempre existe la fila
        // (getOrCreate antes de vender) con default ON.
        const allowNegativeStock = cmpRow?.allowNegativeStock ?? false;

        // Calcular importes de líneas. En 'gross' los unitPrice ya incluyen IVA; en 'net' son netos.
        const computedLines = data.lines.map((line, idx) => {
          const lineTotal = subDecimal(
            mulDecimal(line.quantity, line.unitPrice, 4),
            line.discount ?? '0.0000',
            4,
          );
          return {
            articleId: line.articleId ?? null,
            description: line.description ?? null,
            lineNumber: idx + 1,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: line.discount ?? '0.0000',
            vatRate: line.vatRate ?? '21.00',
            lineTotal,
          };
        });

        const lineSum = sumDecimals(computedLines.map((l) => l.lineTotal));
        const subtotal = lineSum;
        // BUG FISCAL: el descuento global se prorratea sobre las líneas ANTES de
        // calcular el IVA persistido, para que Neto + IVA == Total. Mismo cálculo
        // que `calculateSaleTotals` (pricing) y que el Libro IVA (accounting).
        const { vatAmount } = proratedVatBreakdown(
          computedLines.map((l) => ({ lineTotal: l.lineTotal, vatRate: l.vatRate })),
          saleDiscount,
          subtotal,
          priceMode,
        );
        // 'gross': subtotal ya incluye IVA → total = subtotal − descuento global.
        // 'net':   subtotal es neto → total = subtotal + IVA − descuento global.
        const total =
          priceMode === 'gross'
            ? subDecimal(lineSum, saleDiscount, 4)
            : subDecimal(addDecimal(lineSum, vatAmount, 4), saleDiscount, 4);

        // Validación de pagos.
        if (data.isAccountSale) {
          if (paymentsIn.length > 0) {
            throw new ConstraintError(
              'ACCOUNT_SALE_WITH_PAYMENTS',
              'Una venta a cuenta corriente no lleva pagos',
            );
          }
        } else {
          const paid = sumDecimals(paymentsIn.map((p) => p.amount));
          if (cmpDecimal(paid, total) !== 0) {
            throw new ConstraintError(
              'SALE_PAYMENTS_MISMATCH',
              `La suma de los pagos (${paid}) no coincide con el total de la venta (${total})`,
            );
          }
        }

        // AUDITORÍA sep-2026 (A4): la caja se verificaba 'open' en el servicio,
        // fuera de la transacción. Si otra terminal la cerraba en el medio, la
        // venta y su cobro entraban a una caja ya arqueada y el cierre dejaba
        // de cuadrar. Se vuelve a comprobar acá, dentro de la misma tx.
        const caja = tx
          .select({ status: cashRegisters.status })
          .from(cashRegisters)
          .where(eq(cashRegisters.id, data.cashRegisterId))
          .get();
        if (caja?.status !== 'open') {
          throw new ConstraintError(
            'CASH_CLOSED',
            'La caja se cerró mientras se registraba la venta. Abra una caja e intente de nuevo.',
          );
        }

        // Cabecera.
        const insertedSale = tx
          .insert(sales)
          .values({
            number,
            type: data.type,
            date: now,
            customerId: data.customerId,
            sellerId: data.sellerId,
            cashRegisterId: data.cashRegisterId,
            isAccountSale: data.isAccountSale,
            subtotal,
            discount: saleDiscount,
            vatAmount,
            total,
            status: 'completed',
            notes: data.notes ?? null,
          })
          .returning()
          .all()[0];
        if (!insertedSale) {
          throw new ConstraintError('SALE_INSERT', 'No se pudo registrar la venta');
        }

        // PROMOS: si alguna línea es el artículo espejo de una promoción, el
        // stock se mueve sobre sus COMPONENTES (el stock del espejo no se toca).
        // Las líneas de artículo rápido no tienen artículo: no pueden ser espejo
        // de una promoción y romperían el inArray con un null.
        const lineArticleIds = [
          ...new Set(computedLines.map((l) => l.articleId).filter((x): x is string => x != null)),
        ];
        const promoRows = lineArticleIds.length
          ? tx
              .select({
                promotionId: promotions.id,
                mirrorArticleId: promotions.articleId,
                componentId: promotionItems.articleId,
                componentQty: promotionItems.quantity,
                componentDesc: articles.description,
              })
              .from(promotions)
              .innerJoin(promotionItems, eq(promotionItems.promotionId, promotions.id))
              .innerJoin(articles, eq(articles.id, promotionItems.articleId))
              .where(inArray(promotions.articleId, lineArticleIds))
              .all()
          : [];
        const promoComponentsByMirror = new Map<string, typeof promoRows>();
        for (const row of promoRows) {
          const list = promoComponentsByMirror.get(row.mirrorArticleId) ?? [];
          list.push(row);
          promoComponentsByMirror.set(row.mirrorArticleId, list);
        }
        const discountStock = (articleId: string, quantity: string, label: string): void => {
          const current = tx
            .select({ stock: articles.stock })
            .from(articles)
            .where(eq(articles.id, articleId))
            .get();
          if (!current) throw new NotFoundError('Artículo', articleId);
          if (!allowNegativeStock && !gteDecimal(current.stock, quantity)) {
            throw new ConstraintError(
              'STOCK_INSUFFICIENT',
              `Stock insuficiente para ${label}: hay ${current.stock}, se requieren ${quantity}`,
            );
          }
          tx
            .update(articles)
            .set({ stock: subDecimal(current.stock, quantity, 3) })
            .where(eq(articles.id, articleId))
            .run();
        };

        // Líneas + descuento de stock.
        const insertedLines: SaleLine[] = [];
        for (const l of computedLines) {
          // Artículo rápido (sin artículo): no hay nada en inventario que
          // descontar. Si igual moviéramos stock habría que inventar un
          // artículo por venta, que es lo que dejó el catálogo de StockFácil
          // con 10.323 artículos fantasma en negativo.
          const promoComponents = l.articleId ? promoComponentsByMirror.get(l.articleId) : undefined;
          if (promoComponents && promoComponents.length > 0) {
            for (const comp of promoComponents) {
              discountStock(
                comp.componentId,
                mulDecimal(l.quantity, comp.componentQty, 3),
                `"${comp.componentDesc}" (componente de la promo)`,
              );
            }
          } else if (l.articleId) {
            discountStock(l.articleId, l.quantity, `el artículo ${l.articleId}`);
          }

          // Costo CONGELADO al vender (migración 0024): el margen histórico
          // deja de moverse con los reprecios. En promos, el costo real es la
          // suma de componentes (el artículo espejo suele tener costo 0).
          let costAtSale: string | null = null;
          if (promoComponents && promoComponents.length > 0) {
            let acc = '0.0000';
            for (const comp of promoComponents) {
              const compArt = tx
                .select({ costPrice: articles.costPrice })
                .from(articles)
                .where(eq(articles.id, comp.componentId))
                .get();
              if (compArt) acc = addDecimal(acc, mulDecimal(comp.componentQty, compArt.costPrice, 4), 4);
            }
            costAtSale = acc;
          } else if (l.articleId) {
            const art = tx
              .select({ costPrice: articles.costPrice })
              .from(articles)
              .where(eq(articles.id, l.articleId))
              .get();
            costAtSale = art?.costPrice ?? null;
          }

          const lineRow: NewSaleLine = {
            saleId: insertedSale.id,
            articleId: l.articleId,
            description: l.description,
            lineNumber: l.lineNumber,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discount: l.discount,
            vatRate: l.vatRate,
            lineTotal: l.lineTotal,
            costAtSale,
          };
          const inserted = tx.insert(saleLines).values(lineRow).returning().all()[0];
          if (inserted) insertedLines.push(inserted);
        }

        // Pagos + movimientos de caja.
        const insertedPayments: SalePayment[] = [];
        if (!data.isAccountSale && paymentsIn.length > 0) {
          const pmIds = [...new Set(paymentsIn.map((p) => p.paymentMethodId))];
          const pmRows = tx
            .select()
            .from(paymentMethods)
            .where(inArray(paymentMethods.id, pmIds))
            .all();
          const pmMap = new Map(pmRows.map((r) => [r.id, r]));
          for (const p of paymentsIn) {
            const pm = pmMap.get(p.paymentMethodId);
            if (!pm) throw new NotFoundError('Medio de pago', p.paymentMethodId);
            // Comisión del medio de pago: el comercio la ABSORBE. El cliente paga
            // `amount` íntegro; commissionAmount se descuenta del neto que recibe el
            // comercio. commissionAmount = amount * commissionPct / 100 (4 decimales).
            const commissionPct = pm.commissionPct ?? '0.0000';
            const commissionAmount = mulDecimal(mulDecimal(p.amount, commissionPct, 6), '0.01', 4);
            const netAmount = subDecimal(p.amount, commissionAmount, 4);
            const sp = tx
              .insert(salePayments)
              .values({
                saleId: insertedSale.id,
                paymentMethodId: p.paymentMethodId,
                amount: p.amount,
                reference: p.reference ?? null,
                commissionPct,
                commissionAmount,
                netAmount,
              })
              .returning()
              .all()[0];
            if (!sp) {
              throw new ConstraintError('SALE_PAYMENT_INSERT', 'No se pudo registrar el pago de la venta');
            }
            insertedPayments.push(sp);
            const desc = pm.isPhysicalCash
              ? `Venta ${data.type} #${number}`
              : `Venta ${data.type} #${number} — ${pm.name}`;
            tx
              .insert(cashMovements)
              .values({
                cashRegisterId: data.cashRegisterId,
                type: 'income',
                description: desc,
                amount: p.amount,
                date: now,
                userId: data.sellerId,
                relatedSaleId: insertedSale.id,
                paymentMethodId: pm.id,
              })
              .run();
          }
        }

        // Cuenta corriente (BUG-S03): si es venta a cuenta, la AR se abre DENTRO
        // de esta misma transacción. Antes se creaba en el servicio, fuera de la
        // transacción → si el proceso moría en el medio quedaba una venta
        // isAccountSale=true sin AR (deuda perdida silenciosamente).
        let insertedAr: AccountReceivable | null = null;
        if (data.isAccountSale) {
          // BUG RACE: revalidar el límite de crédito DENTRO de la transacción.
          // El service ya lo chequeó antes (defensa temprana), pero dos ventas a
          // cuenta concurrentes (caso LAN) pueden pasar ese chequeo y superar el
          // límite. Acá recalculamos el balance del cliente con `tx` (mismas
          // cuentas que getTotalBalance) justo antes de abrir la AR.
          // creditLimit '0.0000' / ausente = sin límite.
          const creditLimit = data.creditLimit ?? '0.0000';
          if (Number(creditLimit) > 0) {
            const balRows = tx
              .select({ balance: accountsReceivable.balance })
              .from(accountsReceivable)
              .where(eq(accountsReceivable.customerId, data.customerId))
              .all();
            const currentBalance = sumDecimals(balRows.map((r) => r.balance));
            if (Number(currentBalance) + Number(total) > Number(creditLimit)) {
              throw new ConstraintError(
                'CREDIT_LIMIT_EXCEEDED',
                `Se supera el límite de crédito del cliente (${creditLimit})`,
              );
            }
          }

          insertedAr = tx
            .insert(accountsReceivable)
            .values({
              customerId: data.customerId,
              saleId: insertedSale.id,
              total: insertedSale.total,
              balance: insertedSale.total,
              status: 'open',
            })
            .returning()
            .all()[0] ?? null;
          if (!insertedAr) {
            throw new ConstraintError(
              'AR_INSERT',
              'No se pudo abrir la cuenta corriente de la venta',
            );
          }
        }

        return {
          sale: insertedSale,
          lines: insertedLines,
          payments: insertedPayments,
          accountReceivable: insertedAr,
        };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Anula una venta: marca `status = 'voided'`, restaura el stock de cada línea,
   * genera un movimiento de caja de egreso por la parte que entró en efectivo
   * físico y elimina sus `sale_payments`. Atómico. Si la venta ya tuvo
   * devoluciones, sólo se repone y se reintegra lo que quedaba sin devolver.
   */
  async voidSale(
    id: string,
    opts: { reason?: string | null; userName?: string | null } = {},
  ): Promise<Sale & { reversoElectronico: string }> {
    try {
      return this.db.transaction((tx) => {
        const sale = tx.select().from(sales).where(eq(sales.id, id)).get();
        if (!sale) throw new NotFoundError(this.entityName, id);
        if (sale.status === 'voided') {
          throw new ConstraintError('SALE_ALREADY_VOIDED', `La venta ${id} ya está anulada`);
        }

        const lines = tx.select().from(saleLines).where(eq(saleLines.saleId, id)).all();

        // DEVOLUCIONES PREVIAS (auditoría sep-2026, C1): lo que ya se devolvió
        // ya volvió al stock y ya salió de la caja. Anular la venta entera lo
        // reponía y lo reintegraba por segunda vez (2u vendidas, 1 devuelta,
        // anular → stock +3 y $3000 devueltos sobre $2000 cobrados). Se anula
        // sólo lo que queda sin devolver; si no queda nada, no hay qué anular.
        const devueltoPorLinea = new Map(
          tx
            .select({
              saleLineId: returnLines.saleLineId,
              qty: sql<number>`COALESCE(SUM(CAST(${returnLines.quantity} AS REAL)), 0)`,
            })
            .from(returnLines)
            .innerJoin(returns, eq(returns.id, returnLines.returnId))
            .where(eq(returns.saleId, id))
            .groupBy(returnLines.saleLineId)
            .all()
            .map((r) => [r.saleLineId, r.qty] as const),
        );
        const yaReintegrado = sumDecimals(
          tx
            .select({ total: returns.total })
            .from(returns)
            .where(and(eq(returns.saleId, id), eq(returns.refundMethod, 'cash')))
            .all()
            .map((r) => r.total),
        );
        const pendientes = lines.map((line) => ({
          line,
          quantity: subDecimal(line.quantity, devueltoPorLinea.get(line.id) ?? 0, 3),
        }));
        if (lines.length > 0 && pendientes.every((p) => cmpDecimal(p.quantity, '0') <= 0)) {
          throw new ConstraintError(
            'SALE_FULLY_RETURNED',
            `La venta ${sale.type} #${sale.number} ya fue devuelta por completo: no hay nada que anular`,
          );
        }

        // PROMOS: las líneas cuyo artículo es un espejo de promoción restauran
        // el stock de sus COMPONENTES (espejo intacto), igual que al vender.
        const voidArticleIds = [
          ...new Set(lines.map((l) => l.articleId).filter((x): x is string => x != null)),
        ];
        const voidPromoRows = voidArticleIds.length
          ? tx
              .select({
                mirrorArticleId: promotions.articleId,
                componentId: promotionItems.articleId,
                componentQty: promotionItems.quantity,
              })
              .from(promotions)
              .innerJoin(promotionItems, eq(promotionItems.promotionId, promotions.id))
              .where(inArray(promotions.articleId, voidArticleIds))
              .all()
          : [];
        const voidComponentsByMirror = new Map<string, typeof voidPromoRows>();
        for (const row of voidPromoRows) {
          const list = voidComponentsByMirror.get(row.mirrorArticleId) ?? [];
          list.push(row);
          voidComponentsByMirror.set(row.mirrorArticleId, list);
        }
        const restoreStock = (articleId: string, quantity: string): void => {
          tx
            .update(articles)
            .set({
              stock: sql`printf('%.3f', CAST(${articles.stock} AS REAL) + CAST(${quantity} AS REAL))`,
            })
            .where(eq(articles.id, articleId))
            .run();
        };
        for (const { line, quantity } of pendientes) {
          // Lo ya devuelto de esta línea ya está en el stock.
          if (cmpDecimal(quantity, '0') <= 0) continue;
          // Artículo rápido: al vender no descontó stock, así que al anular no
          // hay nada que devolver. Restaurarlo inventaría mercadería.
          const comps = line.articleId ? voidComponentsByMirror.get(line.articleId) : undefined;
          if (comps && comps.length > 0) {
            for (const comp of comps) {
              restoreStock(comp.componentId, mulDecimal(quantity, comp.componentQty, 3));
            }
          } else if (line.articleId) {
            restoreStock(line.articleId, quantity);
          }
        }

        // Reverso de caja: UN movimiento `expense` por CADA pago de la venta,
        // con su paymentMethodId original.
        // BUG-S04: antes se lumpeaba todo en un único movimiento con el primer
        //   paymentMethodId encontrado → rompía el desglose byPaymentMethod del
        //   arqueo si había >1 medio físico.
        // AUDITORÍA sep-2026 (A1): los pagos NO físicos (transferencia, débito,
        //   QR) no tenían reverso, así que una venta anulada seguía sumando en
        //   el desglose por medio, en el "neto electrónico" del cierre y en lo
        //   depositable a Caja General. Ahora también se revierten: el arqueo
        //   de efectivo no los mira (filtra por isPhysicalCash) y el neto por
        //   medio queda en cero, como corresponde.
        // BUG-S06: si el medio de pago fue borrado, el LEFT JOIN deja `isCash`
        //   en null/undefined. El cierre cuenta esos casos como efectivo físico
        //   (criterio legacy `pmId IS NULL`), así que acá los tratamos igual:
        //   se considera físico salvo que el medio exista y NO sea físico.
        const sps = tx
          .select({
            amount: salePayments.amount,
            pmId: salePayments.paymentMethodId,
            isCash: paymentMethods.isPhysicalCash,
          })
          .from(salePayments)
          .leftJoin(paymentMethods, eq(salePayments.paymentMethodId, paymentMethods.id))
          .where(eq(salePayments.saleId, id))
          .all();
        let reversoElectronico = '0.0000';
        // AUDITORÍA sep-2026: una venta a cuenta corriente con reintegro en
        // EFECTIVO ya entregado no se puede anular sin decidir qué pasa con esa
        // plata: la deuda se borraría y el efectivo quedaría sin contrapartida
        // (el cajón muestra menos de lo que hay). Desde esta versión ya no se
        // puede generar ese caso —la devolución de una venta a cuenta impaga se
        // acredita en la cuenta—, pero las operaciones viejas existen y hay que
        // frenarlas con una explicación, no dejar el descuadre en silencio.
        if (sale.isAccountSale && cmpDecimal(yaReintegrado, '0') > 0) {
          throw new ConstraintError(
            'VOID_ACCOUNT_SALE_WITH_CASH_REFUND',
            `Esta venta a cuenta corriente ya tuvo un reintegro en efectivo de ${Number(yaReintegrado).toFixed(2)}. ` +
              'Para anularla hay que regularizar esa plata primero (registrar el ingreso en la caja o cobrarla), ' +
              'porque al anular se borra la deuda y ese efectivo quedaría sin respaldo.',
          );
        }
        if (!sale.isAccountSale) {
          // Lo que las devoluciones ya reintegraron se descuenta PRIMERO de los
          // pagos físicos (salió del cajón) y, si no alcanzan, de los demás:
          // una venta con débito devuelta en efectivo y después anulada no
          // puede revertir el débito completo (reintegraría dos veces).
          let aDescontar = yaReintegrado;
          const descontar = (s: (typeof sps)[number]) => {
            const usa = cmpDecimal(aDescontar, s.amount) < 0 ? aDescontar : s.amount;
            aDescontar = subDecimal(aDescontar, usa, 4);
            return { ...s, amount: subDecimal(s.amount, usa, 4) };
          };
          const fisicos = sps.filter((s) => s.isCash !== false).map(descontar);
          const electronicos = sps.filter((s) => s.isCash === false).map(descontar);
          const hayFisico = fisicos.some((s) => Number(s.amount) > 0);
          // BUG-CAJA: el reverso EN EFECTIVO no puede entrar a una caja ya
          //   CERRADA y arqueada (el arqueo histórico recalcula el esperado en
          //   vivo y dejaría de cuadrar). La caja DESTINO del efectivo se
          //   resuelve dentro de la transacción:
          //   - caja original 'open'  → usar esa;
          //   - caja original 'closed' (o inexistente) → la caja ABIERTA actual;
          //   - sin caja abierta → abortar pidiendo abrir una.
          //   Lo ELECTRÓNICO va siempre a la caja ORIGINAL (auditoría sep-2026,
          //   A1 cross-caja): no toca el arqueo de efectivo y así el neto
          //   electrónico de ese cierre —lo que podía ingresarse a Caja
          //   General— baja donde corresponde, en vez de dejar un negativo en
          //   la caja de hoy. Si ese cierre ya se había ingresado a Caja
          //   General, el servicio registra allá la salida del reintegro.
          const originReg = tx
            .select({ status: cashRegisters.status })
            .from(cashRegisters)
            .where(eq(cashRegisters.id, sale.cashRegisterId))
            .get();
          const origenCerrada = originReg?.status !== 'open';
          let targetRegisterId = sale.cashRegisterId;
          if (hayFisico && origenCerrada) {
            const openReg = tx
              .select({ id: cashRegisters.id })
              .from(cashRegisters)
              .where(eq(cashRegisters.status, 'open'))
              .limit(1)
              .get();
            if (!openReg) {
              throw new ConstraintError(
                'NO_OPEN_CASH_REGISTER',
                'Abra una caja para poder anular esta operación (la caja original ya está cerrada)',
              );
            }
            targetRegisterId = openReg.id;
          }
          const insertarReverso = (sp: (typeof sps)[number], cashRegisterId: string, desc: string) => {
            // BUG-S06: si el medio de pago ya no existe (isCash == null por el
            // LEFT JOIN), revertir con paymentMethodId NULL — la FK rechazaría
            // un id colgante, y NULL es el criterio legacy de efectivo físico
            // consistente con closeRegister/buildReport.
            let reversePmId: string | null = sp.pmId;
            if (sp.isCash == null) {
              console.warn(
                `[voidSale] venta ${sale.id}: pago con medio ${sp.pmId} sin registro de medio de pago — se revierte como efectivo físico (paymentMethodId NULL)`,
              );
              reversePmId = null;
            }
            tx
              .insert(cashMovements)
              .values({
                cashRegisterId,
                type: 'expense',
                description: desc,
                amount: sp.amount,
                date: Date.now(),
                userId: sale.sellerId,
                relatedSaleId: sale.id,
                paymentMethodId: reversePmId,
              })
              .run();
          };
          for (const sp of fisicos) {
            if (!(Number(sp.amount) > 0)) continue;
            insertarReverso(
              sp,
              targetRegisterId,
              origenCerrada
                ? `Anulación venta ${sale.type} #${sale.number} (caja original cerrada)`
                : `Anulación venta ${sale.type} #${sale.number}`,
            );
          }
          for (const sp of electronicos) {
            if (!(Number(sp.amount) > 0)) continue;
            insertarReverso(
              sp,
              sale.cashRegisterId,
              origenCerrada
                ? `Anulación venta ${sale.type} #${sale.number} (reintegro electrónico, caja cerrada)`
                : `Anulación venta ${sale.type} #${sale.number}`,
            );
            reversoElectronico = addDecimal(reversoElectronico, sp.amount, 4);
          }
        }

        // Eliminar los pagos de la venta.
        tx.delete(salePayments).where(eq(salePayments.saleId, id)).run();

        // Cuenta corriente abierta por esta venta: se cierra EN LA MISMA
        // transacción (antes lo hacía el servicio después, y un corte entre
        // medio dejaba la deuda viva de una venta anulada). Si ya recibió
        // cobranzas no se puede anular.
        const ar = tx.select().from(accountsReceivable).where(eq(accountsReceivable.saleId, id)).get();
        if (ar) {
          const cobranzas = tx
            .select({ n: sql<number>`COUNT(*)` })
            .from(payments)
            .where(eq(payments.accountId, ar.id))
            .get();
          if (Number(cobranzas?.n ?? 0) > 0) {
            throw new ConstraintError(
              'ACCOUNT_SALE_WITH_PAYMENTS',
              'No se puede anular una venta en cuenta corriente que ya recibió pagos',
            );
          }
          tx.delete(accountsReceivable).where(eq(accountsReceivable.id, ar.id)).run();
        }

        // AUDITORÍA sep-2026 (A7): el motivo que la pantalla pedía no se
        // guardaba en ningún lado. Queda en las notas de la venta, con quién y
        // cuándo la anuló, para poder responder después por qué se anuló un
        // comprobante (sobre todo si tenía CAE).
        const motivo = opts.reason?.trim();
        const sello = `[Anulada ${new Date().toLocaleString('es-AR')}${opts.userName ? ` por ${opts.userName}` : ''}${motivo ? `: ${motivo}` : ''}]`;
        const notas = sale.notes ? `${sale.notes}\n${sello}` : sello;
        const updated = tx
          .update(sales)
          .set({ status: 'voided', notes: notas })
          .where(eq(sales.id, id))
          .returning()
          .all()[0];
        if (!updated) throw new NotFoundError(this.entityName, id);
        return { ...updated, reversoElectronico };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Ventas por DÍA DE CAJA (`jornada`): lo vendido después de medianoche con
   * la caja del día anterior abierta cuenta para ese día. Es lo que usan el
   * Historial de Ventas, los reportes y la contabilidad. Ver migración 0036.
   */
  async findByJornadaRange(from: number, to: number): Promise<Sale[]> {
    try {
      return this.db
        .select()
        .from(sales)
        .where(and(gte(sales.jornada, from), lte(sales.jornada, to)))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Ventas por la hora REAL de la venta. Sólo para lo FISCAL (Libro IVA): ahí
   * manda la fecha del comprobante ante ARCA, no el día de caja.
   */
  async findByDateRange(from: number, to: number): Promise<Sale[]> {
    try {
      return this.db
        .select()
        .from(sales)
        .where(and(gte(sales.date, from), lte(sales.date, to)))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Una página de "Facturas emitidas": de la venta más nueva a la más vieja, con
   * los filtros EN LA CONSULTA. Con bases grandes (Nemesis: 287 mil ventas) no
   * se puede traer todo y filtrar en la pantalla. `antesDe` es el cursor (la
   * última venta de la página anterior); `limite` tope 1000.
   */
  async paginaFacturasEmitidas(
    f: FiltroFacturasEmitidas & { antesDe?: { date: number; id: string } | null; limite?: number },
  ): Promise<{ ventas: Sale[]; hayMas: boolean }> {
    try {
      const conds = condicionesFacturasEmitidas(f);
      if (f.antesDe) {
        conds.push(
          or(lt(sales.date, f.antesDe.date), and(eq(sales.date, f.antesDe.date), lt(sales.id, f.antesDe.id)))!,
        );
      }
      const limite = Math.max(1, Math.min(1000, Math.floor(f.limite ?? 200)));
      const filas = this.db
        .select()
        .from(sales)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(sales.date), desc(sales.id))
        .limit(limite + 1)
        .all();
      return { ventas: filas.slice(0, limite), hayMas: filas.length > limite };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Totales de "Facturas emitidas" con los mismos filtros, sumados en la base.
   * Mismo criterio que la pantalla: lo anulado no suma (se cuenta aparte, y sólo
   * si se pidió incluirlo); neto = total − IVA.
   */
  async totalesFacturasEmitidas(
    f: FiltroFacturasEmitidas,
  ): Promise<{ cantidad: number; anuladas: number; total: number; vat: number; clientes: number }> {
    try {
      const conds = condicionesFacturasEmitidas(f);
      const r = this.db
        .select({
          cantidad: sql<number>`coalesce(sum(case when ${sales.status} <> 'voided' then 1 else 0 end), 0)`,
          anuladas: sql<number>`coalesce(sum(case when ${sales.status} = 'voided' then 1 else 0 end), 0)`,
          total: sql<number>`coalesce(sum(case when ${sales.status} <> 'voided' then cast(${sales.total} as real) else 0 end), 0)`,
          vat: sql<number>`coalesce(sum(case when ${sales.status} <> 'voided' then cast(${sales.vatAmount} as real) else 0 end), 0)`,
          clientes: sql<number>`count(distinct ${sales.customerId})`,
        })
        .from(sales)
        .where(conds.length ? and(...conds) : undefined)
        .get();
      return {
        cantidad: Number(r?.cantidad ?? 0),
        anuladas: Number(r?.anuladas ?? 0),
        total: Number(r?.total ?? 0),
        vat: Number(r?.vat ?? 0),
        clientes: Number(r?.clientes ?? 0),
      };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByCustomer(customerId: string): Promise<Sale[]> {
    try {
      return this.db.select().from(sales).where(eq(sales.customerId, customerId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Mapa id → status de las ventas pedidas (para enriquecer reportes). */
  async findStatusesByIds(ids: string[]): Promise<Map<string, Sale['status']>> {
    if (ids.length === 0) return new Map();
    try {
      const rows = this.db
        .select({ id: sales.id, status: sales.status })
        .from(sales)
        .where(inArray(sales.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.status]));
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Busca ventas por su `number` (cast a texto para LIKE), ordenadas por fecha
   * desc, para la búsqueda global (P-BUSQUEDA).
   */
  async findByNumberText(query: string, limit = 8): Promise<Sale[]> {
    try {
      const term = `%${query.trim()}%`;
      return this.db
        .select()
        .from(sales)
        .where(like(sql`CAST(${sales.number} AS TEXT)`, term))
        .orderBy(desc(sales.date))
        .limit(limit)
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findBySeller(sellerId: string): Promise<Sale[]> {
    try {
      return this.db.select().from(sales).where(eq(sales.sellerId, sellerId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
