/**
 * Repositorio FISCAL: configuración de ARCA, puntos de venta y comprobantes
 * electrónicos emitidos.
 *
 * La numeración fiscal es correlativa por (tipo, punto de venta) y no admite
 * huecos ni repetidos. Por eso `reserveNumber` corre en transacción y hay un
 * índice único en la tabla: si dos terminales facturan al mismo tiempo, la
 * segunda falla en vez de duplicar el número.
 */
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  fiscalConfig,
  fiscalVoucherVat,
  fiscalVouchers,
  salePoints,
  type FiscalConfig,
  type FiscalVoucher,
  type FiscalVoucherVat,
  type SalePoint,
} from '../schema/local';

const CONFIG_ID = 'singleton';

export interface SaveFiscalConfigInput {
  environment: 'homologacion' | 'produccion';
  cuit: string;
  businessName?: string | null;
  address?: string | null;
  vatCondition: 'RI' | 'MT';
  grossIncome?: string | null;
  activityStartDate?: number | null;
  certPath?: string | null;
  keyAlias?: string | null;
  enabled: boolean;
}

export interface CreateVoucherInput {
  voucherCode: number;
  letter: 'A' | 'B' | 'C';
  kind: 'invoice' | 'credit_note' | 'debit_note';
  salePoint: number;
  number: number;
  date: number;
  saleId?: string | null;
  relatedVoucherId?: string | null;
  customerId: string;
  customerDocType: number;
  customerDocNumber: string;
  customerName: string;
  netAmount: string;
  vatAmount: string;
  exemptAmount?: string;
  untaxedAmount?: string;
  total: string;
  userId: string;
  vatDetails: { vatId: number; baseAmount: string; vatAmount: string }[];
}

export interface ListVouchersInput {
  from?: number;
  to?: number;
  letter?: 'A' | 'B' | 'C';
  kind?: 'invoice' | 'credit_note' | 'debit_note';
  salePoint?: number;
  status?: 'pending' | 'approved' | 'rejected' | 'error';
  limit?: number;
}

export class FiscalRepository {
  constructor(private readonly db: LocalDatabase) {}

  /* ---------------------------- Configuración ---------------------------- */

  getConfig(): FiscalConfig | null {
    try {
      return this.db.select().from(fiscalConfig).where(eq(fiscalConfig.id, CONFIG_ID)).get() ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  saveConfig(input: SaveFiscalConfigInput): FiscalConfig {
    try {
      const now = Date.now();
      const existing = this.getConfig();
      const row = {
        id: CONFIG_ID,
        environment: input.environment,
        cuit: input.cuit.replace(/\D/g, ''),
        businessName: input.businessName ?? null,
        address: input.address ?? null,
        vatCondition: input.vatCondition,
        grossIncome: input.grossIncome ?? null,
        activityStartDate: input.activityStartDate ?? null,
        certPath: input.certPath ?? null,
        keyAlias: input.keyAlias ?? null,
        enabled: input.enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) {
        this.db.update(fiscalConfig).set(row).where(eq(fiscalConfig.id, CONFIG_ID)).run();
      } else {
        this.db.insert(fiscalConfig).values(row).run();
      }
      return row as FiscalConfig;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /* --------------------------- Puntos de venta --------------------------- */

  listSalePoints(onlyActive = false): SalePoint[] {
    try {
      const q = this.db.select().from(salePoints).$dynamic();
      const rows = onlyActive ? q.where(eq(salePoints.active, true)).all() : q.all();
      return rows.sort((a, b) => a.number - b.number);
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  upsertSalePoint(input: {
    number: number;
    description: string;
    terminalId?: string | null;
    active?: boolean;
  }): SalePoint {
    try {
      const now = Date.now();
      const existing = this.db
        .select()
        .from(salePoints)
        .where(eq(salePoints.number, input.number))
        .get();
      if (existing) {
        const updated = {
          ...existing,
          description: input.description,
          terminalId: input.terminalId ?? existing.terminalId,
          active: input.active ?? existing.active,
          updatedAt: now,
        };
        this.db.update(salePoints).set(updated).where(eq(salePoints.id, existing.id)).run();
        return updated;
      }
      const row: SalePoint = {
        id: uuidv7(),
        number: input.number,
        description: input.description,
        terminalId: input.terminalId ?? null,
        active: input.active ?? true,
        createdAt: now,
        updatedAt: now,
      };
      this.db.insert(salePoints).values(row).run();
      return row;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  deleteSalePoint(id: string): void {
    try {
      this.db.delete(salePoints).where(eq(salePoints.id, id)).run();
    } catch (err) {
      rethrowDbError(err);
    }
  }

  /* ----------------------------- Comprobantes ---------------------------- */

  /**
   * Último número emitido localmente para (tipo, punto de venta).
   *
   * Es solo una referencia: el número REAL a usar lo define ARCA con
   * `FECompUltimoAutorizado`, que es la fuente de verdad. Este método sirve para
   * detectar desfasajes entre lo local y lo que ARCA tiene registrado.
   */
  lastLocalNumber(voucherCode: number, salePoint: number): number {
    try {
      const row = this.db
        .select({ n: sql<number>`COALESCE(MAX(${fiscalVouchers.number}), 0)` })
        .from(fiscalVouchers)
        .where(
          and(
            eq(fiscalVouchers.voucherCode, voucherCode),
            eq(fiscalVouchers.salePoint, salePoint),
          ),
        )
        .get();
      return Number(row?.n ?? 0);
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Persiste un comprobante con su desglose de IVA, en transacción.
   * Se llama DESPUÉS de que ARCA otorgó el CAE.
   */
  createVoucher(
    input: CreateVoucherInput,
    cae: { cae: string; caeExpiry: number | null; observations?: string[]; qrUrl?: string },
  ): FiscalVoucher {
    try {
      return this.db.transaction((tx) => {
        const now = Date.now();
        const row = {
          id: uuidv7(),
          voucherCode: input.voucherCode,
          letter: input.letter,
          kind: input.kind,
          salePoint: input.salePoint,
          number: input.number,
          date: input.date,
          saleId: input.saleId ?? null,
          relatedVoucherId: input.relatedVoucherId ?? null,
          customerId: input.customerId,
          customerDocType: input.customerDocType,
          customerDocNumber: input.customerDocNumber,
          customerName: input.customerName,
          netAmount: input.netAmount,
          vatAmount: input.vatAmount,
          exemptAmount: input.exemptAmount ?? '0.0000',
          untaxedAmount: input.untaxedAmount ?? '0.0000',
          total: input.total,
          cae: cae.cae,
          caeExpiry: cae.caeExpiry,
          status: 'approved' as const,
          observations:
            cae.observations && cae.observations.length > 0 ? cae.observations.join(' | ') : null,
          errors: null,
          qrUrl: cae.qrUrl ?? null,
          userId: input.userId,
          createdAt: now,
          updatedAt: now,
        };
        tx.insert(fiscalVouchers).values(row).run();

        for (const v of input.vatDetails) {
          tx.insert(fiscalVoucherVat)
            .values({
              id: uuidv7(),
              voucherId: row.id,
              vatId: v.vatId,
              baseAmount: v.baseAmount,
              vatAmount: v.vatAmount,
            })
            .run();
        }
        return row as FiscalVoucher;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Deja constancia de un intento fallido, para diagnóstico. */
  recordFailure(input: {
    voucherCode: number;
    letter: 'A' | 'B' | 'C';
    kind: 'invoice' | 'credit_note' | 'debit_note';
    salePoint: number;
    number: number;
    customerId: string;
    customerDocType: number;
    customerDocNumber: string;
    customerName: string;
    total: string;
    userId: string;
    errors: string[];
    saleId?: string | null;
  }): void {
    try {
      const now = Date.now();
      this.db
        .insert(fiscalVouchers)
        .values({
          id: uuidv7(),
          voucherCode: input.voucherCode,
          letter: input.letter,
          kind: input.kind,
          salePoint: input.salePoint,
          // Un rechazo NO consume numeración en ARCA; se guarda con número 0
          // para no bloquear el índice único del número real.
          number: 0,
          date: now,
          saleId: input.saleId ?? null,
          relatedVoucherId: null,
          customerId: input.customerId,
          customerDocType: input.customerDocType,
          customerDocNumber: input.customerDocNumber,
          customerName: input.customerName,
          netAmount: '0.0000',
          vatAmount: '0.0000',
          exemptAmount: '0.0000',
          untaxedAmount: '0.0000',
          total: input.total,
          cae: null,
          caeExpiry: null,
          status: 'rejected',
          observations: null,
          errors: input.errors.join(' | '),
          qrUrl: null,
          userId: input.userId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch {
      /* el registro de diagnóstico nunca debe romper el flujo de venta */
    }
  }

  findVoucherById(id: string): FiscalVoucher | null {
    try {
      return (
        this.db.select().from(fiscalVouchers).where(eq(fiscalVouchers.id, id)).get() ?? null
      );
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  findVoucherBySale(saleId: string): FiscalVoucher | null {
    try {
      return (
        this.db
          .select()
          .from(fiscalVouchers)
          .where(and(eq(fiscalVouchers.saleId, saleId), eq(fiscalVouchers.status, 'approved')))
          .get() ?? null
      );
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  vatDetailsFor(voucherId: string): FiscalVoucherVat[] {
    try {
      return this.db
        .select()
        .from(fiscalVoucherVat)
        .where(eq(fiscalVoucherVat.voucherId, voucherId))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Comprobantes emitidos, para el Libro IVA Ventas y consultas. */
  listVouchers(input: ListVouchersInput = {}): FiscalVoucher[] {
    try {
      const conds: SQL[] = [];
      if (input.from != null) conds.push(gte(fiscalVouchers.date, input.from));
      if (input.to != null) conds.push(lte(fiscalVouchers.date, input.to));
      if (input.letter) conds.push(eq(fiscalVouchers.letter, input.letter));
      if (input.kind) conds.push(eq(fiscalVouchers.kind, input.kind));
      if (input.salePoint != null) conds.push(eq(fiscalVouchers.salePoint, input.salePoint));
      conds.push(eq(fiscalVouchers.status, input.status ?? 'approved'));

      let q = this.db.select().from(fiscalVouchers).$dynamic();
      q = q.where(conds.length === 1 ? conds[0]! : and(...conds)!);
      q = q.orderBy(desc(fiscalVouchers.date), desc(fiscalVouchers.number));
      if (input.limit != null && input.limit > 0) q = q.limit(input.limit);
      return q.all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
