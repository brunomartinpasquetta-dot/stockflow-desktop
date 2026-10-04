/**
 * Repositorio de MANTENIMIENTO — operaciones destructivas de puesta a punto.
 *
 * `resetOperationalData()` deja el sistema "como recién instalado" en la parte
 * OPERATIVA, PERO conservando el catálogo, las entidades maestras y — muy
 * importante — las CUENTAS CORRIENTES (con su historial de ventas/compras),
 * para no romper deudas ni integridad referencial.
 *
 *   SE BORRA (histórico operativo SIN cuenta corriente):
 *     - Ventas de contado (no a cuenta) + sus líneas y pagos
 *     - Compras de contado + líneas
 *     - Devoluciones de esas ventas/compras
 *     - Movimientos de caja diaria de esas operaciones
 *     - Cajas diarias (todas: son del período que se reinicia)
 *     - Caja General: movimientos + saldo a 0
 *   SE RESETEA:
 *     - Stock de TODOS los artículos → 0
 *   SE CONSERVA (intacto):
 *     - Clientes, Proveedores, Artículos (salvo su stock), Familias
 *     - Cuentas corrientes de clientes y proveedores COMPLETAS (accounts_receivable,
 *       payments, supplier_accounts_payable, supplier_payments) — pagadas o no
 *     - Las ventas/compras REFERENCIADAS por esas cuentas corrientes, por
 *       presupuestos convertidos o por órdenes MercadoPago (para no romper FKs)
 *     - Las ventas con comprobante electrónico AUTORIZADO (CAE): son documentos
 *       legales y se quedan con su caja (auditoría sep-2026, B6)
 *     - Los pedidos web y los intentos fiscales sin CAE, desenganchados de la
 *       venta borrada (sale_id = NULL)
 *     - Medios de pago, Precios / lotes de precios, Promociones
 *     - Usuarios, Empresa, Licencia, Auditoría
 *
 * Todo en UNA transacción: si algo falla, no queda a medias.
 */
import { sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  accountsReceivable,
  articles,
  cashGeneral,
  cashGeneralMovements,
  cashMovements,
  cashRegisters,
  fiscalVouchers,
  mpOrders,
  mpPosDevices,
  purchaseLines,
  purchaseReturnLines,
  purchaseReturns,
  purchases,
  quotes,
  returnLines,
  returns,
  salePayments,
  saleLines,
  sales,
  supplierAccountsPayable,
} from '../schema/local';

export interface ResetOperationalResult {
  salesDeleted: number;
  salesKept: number;
  purchasesDeleted: number;
  purchasesKept: number;
  returnsDeleted: number;
  cashRegistersDeleted: number;
  cashGeneralMovementsDeleted: number;
  articlesStockReset: number;
}

export class MaintenanceRepository {
  constructor(private readonly db: LocalDatabase) {}

  /**
   * Pone a cero el histórico operativo y el stock, conservando cuentas
   * corrientes. Ver el encabezado del archivo para el detalle exacto.
   */
  resetOperationalData(): ResetOperationalResult {
    try {
      return this.db.transaction((tx) => {
        const scalar = (q: { get: () => { n: number } | undefined }): number => q.get()?.n ?? 0;

        // Ventas/compras que hay que CONSERVAR: las referenciadas por cuentas
        // corrientes, presupuestos convertidos u órdenes MP (romperían FKs).
        // AUDITORÍA sep-2026 (B6): una venta con comprobante electrónico
        // autorizado por ARCA es un documento legal; borrarla del historial
        // dejaría un CAE emitido del que el sistema ya no sabe nada. Se
        // conservan (con su caja) igual que las de cuenta corriente.
        const keptSaleIds = new Set<string>([
          ...tx.select({ id: accountsReceivable.saleId }).from(accountsReceivable).all().map((r) => r.id),
          ...tx.select({ id: quotes.saleId }).from(quotes).all().map((r) => r.id).filter((x): x is string => !!x),
          ...tx.select({ id: mpOrders.saleId }).from(mpOrders).all().map((r) => r.id).filter((x): x is string => !!x),
          ...tx.select({ id: sales.id }).from(sales).where(sql`${sales.afipCAE} IS NOT NULL AND ${sales.afipCAE} != ''`).all().map((r) => r.id),
          ...tx
            .select({ id: fiscalVouchers.saleId })
            .from(fiscalVouchers)
            .where(sql`${fiscalVouchers.saleId} IS NOT NULL AND ${fiscalVouchers.status} = 'approved'`)
            .all()
            .map((r) => r.id)
            .filter((x): x is string => !!x),
        ]);
        const keptPurchaseIds = new Set<string>(
          tx.select({ id: supplierAccountsPayable.purchaseId }).from(supplierAccountsPayable).all().map((r) => r.id),
        );

        const totalSales = scalar(tx.select({ n: sql<number>`count(*)` }).from(sales));
        const totalPurchases = scalar(tx.select({ n: sql<number>`count(*)` }).from(purchases));
        const returnsDeleted =
          scalar(tx.select({ n: sql<number>`count(*)` }).from(returns)) +
          scalar(tx.select({ n: sql<number>`count(*)` }).from(purchaseReturns));
        const cashRegistersDeleted = scalar(tx.select({ n: sql<number>`count(*)` }).from(cashRegisters));
        const cashGeneralMovementsDeleted = scalar(
          tx.select({ n: sql<number>`count(*)` }).from(cashGeneralMovements),
        );
        const articlesStockReset = scalar(tx.select({ n: sql<number>`count(*)` }).from(articles));

        // Helper: filtro SQL "id NOT IN (...conservados)". Con Set vacío → borra todo.
        const notKept = (ids: Set<string>, col: AnySQLiteColumn): ReturnType<typeof sql> | undefined => {
          if (ids.size === 0) return undefined;
          const list = [...ids];
          return sql`${col} NOT IN (${sql.join(list.map((x) => sql`${x}`), sql`, `)})`;
        };

        // ── Caja diaria PRIMERO (cash_movements referencia sales/purchases) ──
        // Las ventas/compras conservadas (CC) tienen `cashRegisterId` NOT NULL
        // apuntando a la caja donde se registraron → NO se pueden borrar esas
        // cajas. Las cajas a CONSERVAR son las referenciadas por ventas o compras
        // conservadas (mantienen su historial de movimientos intacto).
        const keptSaleList = [...keptSaleIds];
        const keptPurchaseList = [...keptPurchaseIds];
        const inList = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

        // Solo `sales` referencia una caja (cashRegisterId NOT NULL); `purchases`
        // no tiene esa columna.
        const keptRegisterIds = new Set<string>();
        if (keptSaleList.length) {
          for (const row of tx.all(
            sql`SELECT DISTINCT cash_register_id AS id FROM sales WHERE id IN (${inList(keptSaleList)})`,
          ) as { id: string | null }[]) {
            if (row.id) keptRegisterIds.add(row.id);
          }
        }
        const keptRegList = [...keptRegisterIds];

        // Devoluciones que SOBREVIVEN pueden referenciar cajas a borrar → soltar
        // la FK (cashRegisterId es nullable en returns/purchase_returns).
        tx.run(sql`UPDATE returns SET cash_register_id = NULL`);
        tx.run(sql`UPDATE purchase_returns SET cash_register_id = NULL`);

        // Movimientos de las cajas NO conservadas que apuntan a ventas/compras
        // CONSERVADAS: soltar la referencia para poder borrar esos movimientos
        // (los de cajas conservadas se quedan con su historial intacto).
        const regNotKept = keptRegList.length
          ? sql`cash_register_id NOT IN (${inList(keptRegList)})`
          : sql`1 = 1`;
        if (keptSaleList.length) {
          tx.run(sql`UPDATE cash_movements SET related_sale_id = NULL WHERE related_sale_id IN (${inList(keptSaleList)}) AND ${regNotKept}`);
        }
        if (keptPurchaseList.length) {
          tx.run(sql`UPDATE cash_movements SET related_purchase_id = NULL WHERE related_purchase_id IN (${inList(keptPurchaseList)}) AND ${regNotKept}`);
        }

        // Borrar los MOVIMIENTOS de caja no conservados ahora (no referencian
        // sales/purchases tras las nulificaciones de arriba). Las CAJAS se borran
        // al FINAL, después de las ventas: `sales.cashRegisterId` es NOT NULL y
        // apunta a la caja donde se registró la venta, así que hay que eliminar
        // primero las ventas de esas cajas.
        if (keptRegList.length) {
          tx.run(sql`DELETE FROM cash_movements WHERE cash_register_id NOT IN (${inList(keptRegList)})`);
        } else {
          tx.delete(cashMovements).run();
        }

        // ── Devoluciones: solo de ventas/compras que se van a borrar ──
        const delReturnLines = notKept(keptSaleIds, returns.saleId);
        // return_lines cuelga de returns → borrar por subquery
        if (keptSaleIds.size === 0) {
          tx.delete(returnLines).run();
          tx.delete(returns).run();
        } else {
          tx.run(sql`DELETE FROM return_lines WHERE return_id IN (SELECT id FROM returns WHERE ${delReturnLines})`);
          tx.delete(returns).where(delReturnLines).run();
        }
        const delPurchReturns = notKept(keptPurchaseIds, purchaseReturns.purchaseId);
        if (keptPurchaseIds.size === 0) {
          tx.delete(purchaseReturnLines).run();
          tx.delete(purchaseReturns).run();
        } else {
          tx.run(sql`DELETE FROM purchase_return_lines WHERE return_id IN (SELECT id FROM purchase_returns WHERE ${delPurchReturns})`);
          tx.delete(purchaseReturns).where(delPurchReturns).run();
        }

        // ── mp_orders ──
        // Las de ventas conservadas se quedan (su venta las referencia). Las de
        // ventas a borrar Y las que nunca llegaron a venta (QR expirado o
        // cancelado) se van: `mp_orders.mp_pos_device_id` es NOT NULL y
        // apunta al POS de una caja que se borra; una sola huérfana hacía
        // fallar el reinicio entero por FK (auditoría sep-2026, A8).
        if (keptSaleIds.size > 0) {
          tx.run(sql`DELETE FROM mp_orders WHERE sale_id IS NULL OR sale_id NOT IN (${inList(keptSaleList)})`);
        } else {
          tx.delete(mpOrders).run();
        }

        // ── Presupuestos: soltar la traza saleId de ventas a borrar (no borro presupuestos) ──
        tx.run(sql`UPDATE quotes SET sale_id = NULL WHERE sale_id IS NOT NULL${keptSaleIds.size > 0 ? sql` AND sale_id NOT IN (${sql.join([...keptSaleIds].map((x) => sql`${x}`), sql`, `)})` : sql``}`);

        // ── Pedidos web: el pedido queda (es historial del catálogo) pero sin
        //    la venta que se borra. Antes esta FK hacía fallar el reinicio entero
        //    en cuanto había un pedido convertido (B6).
        tx.run(sql`UPDATE catalogo_pedidos SET sale_id = NULL WHERE sale_id IS NOT NULL${keptSaleIds.size > 0 ? sql` AND sale_id NOT IN (${inList(keptSaleList)})` : sql``}`);

        // ── Intentos fiscales sin CAE (rechazados / sin respuesta) de ventas a
        //    borrar: se conserva el registro del intento, sin la venta.
        tx.run(sql`UPDATE fiscal_vouchers SET sale_id = NULL WHERE sale_id IS NOT NULL${keptSaleIds.size > 0 ? sql` AND sale_id NOT IN (${inList(keptSaleList)})` : sql``}`);

        // Movimientos de caja SUPERVIVIENTES (en cajas conservadas) que apuntan
        // a ventas/compras que SÍ se borran → soltar la referencia para no romper
        // la FK al eliminar esas ventas/compras.
        if (keptSaleList.length) {
          tx.run(sql`UPDATE cash_movements SET related_sale_id = NULL WHERE related_sale_id IS NOT NULL AND related_sale_id NOT IN (${inList(keptSaleList)})`);
        } else {
          tx.run(sql`UPDATE cash_movements SET related_sale_id = NULL WHERE related_sale_id IS NOT NULL`);
        }
        if (keptPurchaseList.length) {
          tx.run(sql`UPDATE cash_movements SET related_purchase_id = NULL WHERE related_purchase_id IS NOT NULL AND related_purchase_id NOT IN (${inList(keptPurchaseList)})`);
        } else {
          tx.run(sql`UPDATE cash_movements SET related_purchase_id = NULL WHERE related_purchase_id IS NOT NULL`);
        }

        // ── Ventas (líneas y pagos primero por las FKs cascade, pero explícito) ──
        const delSales = notKept(keptSaleIds, sales.id);
        if (keptSaleIds.size === 0) {
          tx.delete(salePayments).run();
          tx.delete(saleLines).run();
          tx.delete(sales).run();
        } else {
          const kept = sql.join([...keptSaleIds].map((x) => sql`${x}`), sql`, `);
          tx.run(sql`DELETE FROM sale_payments WHERE sale_id NOT IN (${kept})`);
          tx.run(sql`DELETE FROM sale_lines WHERE sale_id NOT IN (${kept})`);
          tx.delete(sales).where(delSales).run();
        }

        // ── Compras ──
        const delPurchases = notKept(keptPurchaseIds, purchases.id);
        if (keptPurchaseIds.size === 0) {
          tx.delete(purchaseLines).run();
          tx.delete(purchases).run();
        } else {
          const kept = sql.join([...keptPurchaseIds].map((x) => sql`${x}`), sql`, `);
          tx.run(sql`DELETE FROM purchase_lines WHERE purchase_id NOT IN (${kept})`);
          tx.delete(purchases).where(delPurchases).run();
        }

        // ── Cajas diarias: ahora que ya no quedan ventas apuntando a ellas
        //    (salvo las de CC en cajas conservadas), se borran las no conservadas.
        //    El POS de Mercado Pago asociado a una caja borrada se desasocia
        //    (FK NOT NULL): se vuelve a vincular desde Configuración (B6).
        if (keptRegList.length) {
          tx.run(sql`DELETE FROM mp_pos_devices WHERE cash_register_id NOT IN (${inList(keptRegList)})`);
          tx.run(sql`DELETE FROM cash_registers WHERE id NOT IN (${inList(keptRegList)})`);
        } else {
          tx.delete(mpPosDevices).run();
          tx.delete(cashRegisters).run();
        }

        // ── Caja General: movimientos + saldos (total/efectivo/electrónico) a 0 ──
        tx.delete(cashGeneralMovements).run();
        tx
          .update(cashGeneral)
          .set({ currentBalance: '0', cashBalance: '0', electronicBalance: '0', lastUpdate: Date.now() })
          .run();

        // ── Stock de todos los artículos → 0 (NO borra artículos) ──
        tx.update(articles).set({ stock: '0.000' }).run();

        const salesKept = keptSaleIds.size;
        const purchasesKept = keptPurchaseIds.size;
        return {
          salesDeleted: totalSales - salesKept,
          salesKept,
          purchasesDeleted: totalPurchases - purchasesKept,
          purchasesKept,
          returnsDeleted,
          cashRegistersDeleted,
          cashGeneralMovementsDeleted,
          articlesStockReset,
        };
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }
}
