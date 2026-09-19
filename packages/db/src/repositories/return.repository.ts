/**
 * Repositorio de DEVOLUCIONES (ventas y compras), total o parcial por líneas.
 *
 * Devolución de VENTA: el stock VUELVE (si la línea es una promo, vuelven sus
 * componentes) y el reintegro sale en efectivo (egreso de caja) o como crédito
 * en la cuenta corriente (baja el saldo de la AR de esa venta).
 *
 * Devolución de COMPRA: el stock BAJA (la mercadería vuelve al proveedor) y el
 * reintegro entra en efectivo (ingreso de caja) o baja la deuda con el
 * proveedor (AP de esa compra).
 *
 * Ambas usan serie de numeración propia (DEV #N / DPC #N) calculada dentro de
 * la transacción.
 */
import { and, desc, eq, inArray, max, sql } from 'drizzle-orm';
import {
  type PriceMode,
  cmpDecimal,
  gteDecimal,
  mulDecimal,
  subDecimal,
  sumDecimals,
  vatBreakdown,
} from '@stockflow/shared';

import {
  accountsReceivable,
  articles,
  companies,
  cashMovements,
  cashRegisters,
  paymentMethods,
  promotionItems,
  promotions,
  purchaseLines,
  purchaseReturnLines,
  purchaseReturns,
  purchases,
  returnLines,
  returns,
  saleLines,
  sales,
  supplierAccountsPayable,
  type NewReturn,
  type PurchaseReturn,
  type PurchaseReturnLine,
  type Return,
  type ReturnLine,
} from '../schema/local';
import type { LocalDatabase } from '../local/client';
import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import { BaseRepository } from './base.repository';

export interface ReturnLineDraft {
  saleLineId: string;
  quantity: string;
}
export interface CreateSaleReturnInput {
  saleId: string;
  userId: string;
  cashRegisterId?: string | null;
  refundMethod: 'cash' | 'account';
  notes?: string | null;
  lines: ReturnLineDraft[];
}
export interface SaleReturnResult {
  ret: Return;
  lines: ReturnLine[];
}

export interface PurchaseReturnLineDraft {
  purchaseLineId: string;
  quantity: string;
}
export interface CreatePurchaseReturnInput {
  purchaseId: string;
  userId: string;
  cashRegisterId?: string | null;
  refundMethod: 'cash' | 'account';
  notes?: string | null;
  lines: PurchaseReturnLineDraft[];
}
export interface PurchaseReturnResult {
  ret: PurchaseReturn;
  lines: PurchaseReturnLine[];
}

/** Precio unitario EFECTIVO de la línea original (con su descuento de línea). */
function effectiveUnit(lineTotal: string, quantity: string): number {
  const q = Number(quantity);
  return q > 0 ? Number(lineTotal) / q : 0;
}

/** Tipo del `tx` dentro de `db.transaction((tx) => …)`. */
type Tx = Parameters<Parameters<LocalDatabase['transaction']>[0]>[0];

export class ReturnRepository extends BaseRepository<Return, NewReturn> {
  constructor(db: LocalDatabase) {
    super(db, returns, 'Devolución');
  }

  /* ------------------------- VENTAS ------------------------- */

  /**
   * Valida las líneas a devolver y calcula cuánto se reintegra: lo que el
   * cliente PAGÓ por esas unidades, no el importe de lista de la línea.
   *
   * Auditoría sep-2026 (C2): una venta de $1000 con $100 de descuento global
   * cobraba $900 y la devolución reintegraba $1000; en modo 'net' pasaba lo
   * inverso (cobraba $1210 con IVA y devolvía $1000). Por eso cada línea lleva
   * su parte del descuento global —el mismo prorrateo que `proratedVatBreakdown`
   * usa para el IVA persistido— y, en 'net', el IVA que el cliente pagó.
   * Tope: la suma de reintegros de la venta nunca supera su total; con la
   * última unidad se reintegra exactamente lo que faltaba, así los centavos
   * del prorrateo no quedan colgados.
   */
  private computeSaleReturn(tx: Tx, input: { saleId: string; lines: ReturnLineDraft[] }) {
    const sale = tx.select().from(sales).where(eq(sales.id, input.saleId)).get();
    if (!sale) throw new NotFoundError('Venta', input.saleId);
    if (sale.status !== 'completed') {
      throw new ConstraintError('SALE_NOT_COMPLETED', 'Sólo se pueden devolver ventas completadas (no anuladas)');
    }
    const cmpRow = tx.select({ priceMode: companies.priceMode }).from(companies).limit(1).get();
    const priceMode: PriceMode = cmpRow?.priceMode === 'net' ? 'net' : 'gross';

    const slRows = tx.select().from(saleLines).where(eq(saleLines.saleId, input.saleId)).all();
    const slById = new Map(slRows.map((l) => [l.id, l]));

    // Cantidades ya devueltas por línea (devoluciones anteriores).
    const prevRows = tx
      .select({
        saleLineId: returnLines.saleLineId,
        qty: sql<string>`COALESCE(SUM(CAST(${returnLines.quantity} AS REAL)), 0)`,
      })
      .from(returnLines)
      .where(inArray(returnLines.saleLineId, slRows.map((l) => l.id)))
      .groupBy(returnLines.saleLineId)
      .all();
    const prevByLine = new Map(prevRows.map((r) => [r.saleLineId, Number(r.qty)]));
    // Plata ya reintegrada por esta venta (cualquier medio): el tope es el total cobrado.
    const yaReintegrado = sumDecimals(
      tx.select({ total: returns.total }).from(returns).where(eq(returns.saleId, sale.id)).all().map((r) => r.total),
    );

    // Validar y computar líneas.
    if (input.lines.length === 0) {
      throw new ConstraintError('RETURN_EMPTY', 'Seleccione al menos un artículo a devolver');
    }
    const prorratea = Number(sale.discount) !== 0 && Number(sale.subtotal) !== 0;
    const pedidoPorLinea = new Map<string, number>();
    const computed = input.lines.map((l) => {
      const sl = slById.get(l.saleLineId);
      if (!sl) throw new NotFoundError('Línea de venta', l.saleLineId);
      const qty = Number(l.quantity);
      if (!(qty > 0)) throw new ConstraintError('RETURN_QTY', 'La cantidad a devolver debe ser mayor a cero');
      const remaining = Number(sl.quantity) - (prevByLine.get(sl.id) ?? 0);
      if (qty > remaining + 0.0005) {
        throw new ConstraintError(
          'RETURN_QTY_EXCEEDS',
          `No se puede devolver ${l.quantity}: de esa línea quedan ${remaining.toFixed(3)} sin devolver`,
        );
      }
      pedidoPorLinea.set(sl.id, (pedidoPorLinea.get(sl.id) ?? 0) + qty);
      // Lo que el cliente pagó por la línea: con su parte del descuento global
      // y, en modo 'net', con el IVA (en 'gross' el lineTotal ya lo incluye).
      const lineDiscount = prorratea
        ? mulDecimal(sale.discount, (Number(sl.lineTotal) / Number(sale.subtotal)).toFixed(8), 4)
        : '0.0000';
      const linePaid = vatBreakdown(subDecimal(sl.lineTotal, lineDiscount, 4), sl.vatRate, priceMode).gross;
      const lineTotal = (effectiveUnit(linePaid, sl.quantity) * qty).toFixed(4);
      return {
        saleLineId: sl.id,
        articleId: sl.articleId,
        quantity: qty.toFixed(3),
        unitPrice: sl.unitPrice,
        lineTotal,
      };
    });
    let total = sumDecimals(computed.map((c) => c.lineTotal));
    if (!(Number(total) > 0)) {
      throw new ConstraintError('RETURN_TOTAL', 'El total de la devolución debe ser mayor a cero');
    }
    const restante = subDecimal(sale.total, yaReintegrado, 4);
    if (cmpDecimal(restante, '0') <= 0) {
      throw new ConstraintError(
        'RETURN_TOTAL_REFUNDED',
        `Ya se reintegró el total de la venta (${sale.total}): no queda nada por devolver`,
      );
    }
    const devuelveTodo = slRows.every(
      (sl) => Number(sl.quantity) - (prevByLine.get(sl.id) ?? 0) - (pedidoPorLinea.get(sl.id) ?? 0) <= 0.0005,
    );
    if (devuelveTodo || cmpDecimal(total, restante) > 0) total = restante;

    return { sale, computed, total };
  }

  /**
   * Cuánto reintegraría esta devolución, sin escribir nada. Lo usa el servicio
   * para comprobar que el cajón tenga ese efectivo antes de registrarla.
   */
  async previewSaleReturn(input: { saleId: string; lines: ReturnLineDraft[] }): Promise<string> {
    try {
      return this.db.transaction((tx) => this.computeSaleReturn(tx, input).total);
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async createSaleReturn(input: CreateSaleReturnInput): Promise<SaleReturnResult> {
    try {
      return this.db.transaction((tx) => {
        const now = Date.now();

        const { sale, computed, total } = this.computeSaleReturn(tx, input);

        // Stock: VUELVE. Si la línea es un artículo espejo de promo → componentes.
        // Los artículos rápidos no tienen artículo: no pueden ser espejo de
        // promo y romperían el inArray con un null.
        const artIds = [
          ...new Set(computed.map((c) => c.articleId).filter((x): x is string => x != null)),
        ];
        const promoRows = tx
          .select({
            mirrorArticleId: promotions.articleId,
            componentId: promotionItems.articleId,
            componentQty: promotionItems.quantity,
          })
          .from(promotions)
          .innerJoin(promotionItems, eq(promotionItems.promotionId, promotions.id))
          .where(inArray(promotions.articleId, artIds))
          .all();
        const compsByMirror = new Map<string, typeof promoRows>();
        for (const row of promoRows) {
          const list = compsByMirror.get(row.mirrorArticleId) ?? [];
          list.push(row);
          compsByMirror.set(row.mirrorArticleId, list);
        }
        const bumpStock = (articleId: string, qty: string): void => {
          tx
            .update(articles)
            .set({ stock: sql`printf('%.3f', CAST(${articles.stock} AS REAL) + CAST(${qty} AS REAL))` })
            .where(eq(articles.id, articleId))
            .run();
        };
        for (const c of computed) {
          // Artículo rápido: la venta no descontó stock, así que la devolución
          // no repone nada. Sólo se reintegra la plata.
          const comps = c.articleId ? compsByMirror.get(c.articleId) : undefined;
          if (comps && comps.length > 0) {
            for (const comp of comps) {
              bumpStock(comp.componentId, (Number(c.quantity) * Number(comp.componentQty)).toFixed(3));
            }
          } else if (c.articleId) {
            bumpStock(c.articleId, c.quantity);
          }
        }

        // Numeración DEV (serie propia).
        const numRow = tx.select({ value: max(returns.number) }).from(returns).get();
        const number = (numRow?.value ?? 0) + 1;

        // Reintegro.
        let cashRegisterId: string | null = null;
        if (input.refundMethod === 'cash') {
          if (!input.cashRegisterId) {
            throw new ConstraintError('RETURN_NO_CASH', 'Para reintegrar en efectivo tiene que haber una caja abierta');
          }
          const reg = tx.select().from(cashRegisters).where(eq(cashRegisters.id, input.cashRegisterId)).get();
          if (!reg || reg.status !== 'open') {
            throw new ConstraintError('RETURN_NO_CASH', 'Para reintegrar en efectivo tiene que haber una caja abierta');
          }
          const cashPm = tx
            .select()
            .from(paymentMethods)
            .where(and(eq(paymentMethods.type, 'cash'), eq(paymentMethods.isPhysicalCash, true)))
            .get();
          tx
            .insert(cashMovements)
            .values({
              cashRegisterId: reg.id,
              type: 'expense',
              description: `Devolución venta ${sale.type} #${sale.number} — DEV #${number}`,
              amount: total,
              date: now,
              userId: input.userId,
              relatedSaleId: sale.id,
              paymentMethodId: cashPm?.id ?? null,
            })
            .run();
          cashRegisterId = reg.id;
        } else {
          // Crédito en cuenta corriente: baja el saldo de la AR de ESTA venta.
          const ar = tx
            .select()
            .from(accountsReceivable)
            .where(eq(accountsReceivable.saleId, sale.id))
            .get();
          if (!ar) {
            throw new ConstraintError(
              'RETURN_NO_ACCOUNT',
              'Esta venta no fue a cuenta corriente: el reintegro debe ser en efectivo',
            );
          }
          if (!gteDecimal(ar.balance, total)) {
            throw new ConstraintError(
              'RETURN_EXCEEDS_BALANCE',
              `El crédito (${total}) supera el saldo pendiente del comprobante (${ar.balance}). Devolvé esa diferencia en efectivo.`,
            );
          }
          const newBalance = subDecimal(ar.balance, total, 4);
          const newStatus = Number(newBalance) === 0 ? 'paid' : newBalance === ar.total ? 'open' : 'partial';
          tx
            .update(accountsReceivable)
            .set({ balance: newBalance, status: newStatus })
            .where(eq(accountsReceivable.id, ar.id))
            .run();
        }

        const ret = tx
          .insert(returns)
          .values({
            number,
            saleId: sale.id,
            customerId: sale.customerId,
            userId: input.userId,
            cashRegisterId,
            date: now,
            refundMethod: input.refundMethod,
            total,
            notes: input.notes ?? null,
          })
          .returning()
          .all()[0];
        if (!ret) throw new ConstraintError('RETURN_INSERT', 'No se pudo registrar la devolución');

        const insertedLines: ReturnLine[] = [];
        for (const c of computed) {
          const row = tx
            .insert(returnLines)
            .values({ returnId: ret.id, ...c })
            .returning()
            .all()[0];
          if (row) insertedLines.push(row);
        }
        return { ret, lines: insertedLines };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findBySale(saleId: string): Promise<SaleReturnResult[]> {
    const rets = this.db
      .select()
      .from(returns)
      .where(eq(returns.saleId, saleId))
      .orderBy(desc(returns.date))
      .all();
    if (rets.length === 0) return [];
    const lines = this.db
      .select()
      .from(returnLines)
      .where(inArray(returnLines.returnId, rets.map((r) => r.id)))
      .all();
    return rets.map((ret) => ({ ret, lines: lines.filter((l) => l.returnId === ret.id) }));
  }

  /* ------------------------- COMPRAS ------------------------- */

  async createPurchaseReturn(input: CreatePurchaseReturnInput): Promise<PurchaseReturnResult> {
    try {
      return this.db.transaction((tx) => {
        const now = Date.now();

        const purchase = tx.select().from(purchases).where(eq(purchases.id, input.purchaseId)).get();
        if (!purchase) throw new NotFoundError('Compra', input.purchaseId);
        if (purchase.status !== 'completed') {
          throw new ConstraintError('PURCHASE_NOT_COMPLETED', 'Sólo se pueden devolver compras completadas (no anuladas)');
        }

        const plRows = tx.select().from(purchaseLines).where(eq(purchaseLines.purchaseId, input.purchaseId)).all();
        const plById = new Map(plRows.map((l) => [l.id, l]));

        const prevRows = tx
          .select({
            purchaseLineId: purchaseReturnLines.purchaseLineId,
            qty: sql<string>`COALESCE(SUM(CAST(${purchaseReturnLines.quantity} AS REAL)), 0)`,
          })
          .from(purchaseReturnLines)
          .where(inArray(purchaseReturnLines.purchaseLineId, plRows.map((l) => l.id)))
          .groupBy(purchaseReturnLines.purchaseLineId)
          .all();
        const prevByLine = new Map(prevRows.map((r) => [r.purchaseLineId, Number(r.qty)]));

        if (input.lines.length === 0) {
          throw new ConstraintError('RETURN_EMPTY', 'Seleccione al menos un artículo a devolver');
        }
        const computed = input.lines.map((l) => {
          const pl = plById.get(l.purchaseLineId);
          if (!pl) throw new NotFoundError('Línea de compra', l.purchaseLineId);
          const qty = Number(l.quantity);
          if (!(qty > 0)) throw new ConstraintError('RETURN_QTY', 'La cantidad a devolver debe ser mayor a cero');
          const remaining = Number(pl.quantity) - (prevByLine.get(pl.id) ?? 0);
          if (qty > remaining + 0.0005) {
            throw new ConstraintError(
              'RETURN_QTY_EXCEEDS',
              `No se puede devolver ${l.quantity}: de esa línea quedan ${remaining.toFixed(3)} sin devolver`,
            );
          }
          const lineTotal = (effectiveUnit(pl.lineTotal, pl.quantity) * qty).toFixed(4);
          return {
            purchaseLineId: pl.id,
            articleId: pl.articleId,
            quantity: qty.toFixed(3),
            unitPrice: pl.costPrice,
            lineTotal,
          };
        });
        const total = sumDecimals(computed.map((c) => c.lineTotal));
        if (!(Number(total) > 0)) {
          throw new ConstraintError('RETURN_TOTAL', 'El total de la devolución debe ser mayor a cero');
        }

        // Stock: BAJA (la mercadería vuelve al proveedor). Respeta "vender sin stock".
        const cmpRow = tx.select({ allowNegativeStock: companies.allowNegativeStock }).from(companies).limit(1).get();
        const allowNegative = cmpRow?.allowNegativeStock ?? true;
        for (const c of computed) {
          const cur = tx.select({ stock: articles.stock, description: articles.description }).from(articles).where(eq(articles.id, c.articleId)).get();
          if (!cur) throw new NotFoundError('Artículo', c.articleId);
          if (!allowNegative && !gteDecimal(cur.stock, c.quantity)) {
            throw new ConstraintError(
              'STOCK_INSUFFICIENT',
              `Stock insuficiente para devolver "${cur.description}": hay ${cur.stock}, se devuelven ${c.quantity}`,
            );
          }
          tx
            .update(articles)
            .set({ stock: subDecimal(cur.stock, c.quantity, 3) })
            .where(eq(articles.id, c.articleId))
            .run();
        }

        const numRow = tx.select({ value: max(purchaseReturns.number) }).from(purchaseReturns).get();
        const number = (numRow?.value ?? 0) + 1;

        let cashRegisterId: string | null = null;
        if (input.refundMethod === 'cash') {
          if (!input.cashRegisterId) {
            throw new ConstraintError('RETURN_NO_CASH', 'Para recibir el reintegro en efectivo tiene que haber una caja abierta');
          }
          const reg = tx.select().from(cashRegisters).where(eq(cashRegisters.id, input.cashRegisterId)).get();
          if (!reg || reg.status !== 'open') {
            throw new ConstraintError('RETURN_NO_CASH', 'Para recibir el reintegro en efectivo tiene que haber una caja abierta');
          }
          const cashPm = tx
            .select()
            .from(paymentMethods)
            .where(and(eq(paymentMethods.type, 'cash'), eq(paymentMethods.isPhysicalCash, true)))
            .get();
          tx
            .insert(cashMovements)
            .values({
              cashRegisterId: reg.id,
              type: 'income',
              description: `Devolución compra ${purchase.type} #${purchase.number} — DPC #${number}`,
              amount: total,
              date: now,
              userId: input.userId,
              relatedPurchaseId: purchase.id,
              paymentMethodId: cashPm?.id ?? null,
            })
            .run();
          cashRegisterId = reg.id;
        } else {
          const ap = tx
            .select()
            .from(supplierAccountsPayable)
            .where(eq(supplierAccountsPayable.purchaseId, purchase.id))
            .get();
          if (!ap) {
            throw new ConstraintError(
              'RETURN_NO_ACCOUNT',
              'Esta compra no fue a cuenta del proveedor: el reintegro debe ser en efectivo',
            );
          }
          if (!gteDecimal(ap.balance, total)) {
            throw new ConstraintError(
              'RETURN_EXCEEDS_BALANCE',
              `El crédito (${total}) supera la deuda pendiente de la factura (${ap.balance}).`,
            );
          }
          const newBalance = subDecimal(ap.balance, total, 4);
          const newStatus = Number(newBalance) === 0 ? 'paid' : newBalance === ap.total ? 'open' : 'partial';
          tx
            .update(supplierAccountsPayable)
            .set({ balance: newBalance, status: newStatus })
            .where(eq(supplierAccountsPayable.id, ap.id))
            .run();
        }

        const ret = tx
          .insert(purchaseReturns)
          .values({
            number,
            purchaseId: purchase.id,
            supplierId: purchase.supplierId,
            userId: input.userId,
            cashRegisterId,
            date: now,
            refundMethod: input.refundMethod,
            total,
            notes: input.notes ?? null,
          })
          .returning()
          .all()[0];
        if (!ret) throw new ConstraintError('RETURN_INSERT', 'No se pudo registrar la devolución');

        const insertedLines: PurchaseReturnLine[] = [];
        for (const c of computed) {
          const row = tx
            .insert(purchaseReturnLines)
            .values({ returnId: ret.id, ...c })
            .returning()
            .all()[0];
          if (row) insertedLines.push(row);
        }
        return { ret, lines: insertedLines };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByPurchase(purchaseId: string): Promise<PurchaseReturnResult[]> {
    const rets = this.db
      .select()
      .from(purchaseReturns)
      .where(eq(purchaseReturns.purchaseId, purchaseId))
      .orderBy(desc(purchaseReturns.date))
      .all();
    if (rets.length === 0) return [];
    const lines = this.db
      .select()
      .from(purchaseReturnLines)
      .where(inArray(purchaseReturnLines.returnId, rets.map((r) => r.id)))
      .all();
    return rets.map((ret) => ({ ret, lines: lines.filter((l) => l.returnId === ret.id) }));
  }

  /** Devoluciones con crédito a cuenta de un conjunto de ventas (para el estado de cuenta). */
  async findAccountCreditsBySales(saleIds: string[]): Promise<Return[]> {
    if (saleIds.length === 0) return [];
    return this.db
      .select()
      .from(returns)
      .where(and(inArray(returns.saleId, saleIds), eq(returns.refundMethod, 'account')))
      .all();
  }

  /** Ídem para compras (estado de cuenta del proveedor). */
  async findAccountCreditsByPurchases(purchaseIds: string[]): Promise<PurchaseReturn[]> {
    if (purchaseIds.length === 0) return [];
    return this.db
      .select()
      .from(purchaseReturns)
      .where(and(inArray(purchaseReturns.purchaseId, purchaseIds), eq(purchaseReturns.refundMethod, 'account')))
      .all();
  }

}
