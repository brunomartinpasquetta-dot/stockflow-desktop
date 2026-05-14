/**
 * Reporte impreso de Libro IVA (ventas o compras), A4 horizontal-ish.
 * Soporta paginación natural con `page-break-inside: avoid` en cada `<tr>`.
 */
import { useState } from 'react'

import type { CompanyDTO, VatBookPurchaseRowDTO, VatBookSaleRowDTO } from '@/types/api'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'

export interface VatBookTotals {
  net: string
  vat21: string
  vat105: string
  vat27: string
  total: string
  count: number
}

export type VatBookReportData =
  | {
      kind: 'sales'
      company: CompanyDTO
      period: { from: number; to: number }
      salesRows: VatBookSaleRowDTO[]
      totals: VatBookTotals
    }
  | {
      kind: 'purchases'
      company: CompanyDTO
      period: { from: number; to: number }
      purchaseRows: VatBookPurchaseRowDTO[]
      totals: VatBookTotals
    }

export function VatBookReport({ data }: { data: VatBookReportData }) {
  const [printedAt] = useState(() => Date.now())
  const title = data.kind === 'sales' ? 'Libro IVA Ventas' : 'Libro IVA Compras'

  return (
    <div className="print-a4">
      <div className="mb-3 border-b pb-2">
        <div className="text-lg font-bold uppercase">{data.company.name}</div>
        {data.company.cuit && <div className="text-xs">CUIT: {data.company.cuit}</div>}
      </div>

      <h1 className="mb-1 text-base font-bold">{title}</h1>
      <div className="mb-3 text-xs">
        <div>Desde: {formatDate(data.period.from)}</div>
        <div>Hasta: {formatDate(data.period.to)}</div>
        <div>Comprobantes: {data.totals.count}</div>
      </div>

      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1 pr-2">Fecha</th>
            <th className="py-1 pr-2">Tipo</th>
            <th className="py-1 pr-2">N°</th>
            <th className="py-1 pr-2">{data.kind === 'sales' ? 'Cliente' : 'Proveedor'}</th>
            <th className="py-1 pr-2">CUIT</th>
            <th className="py-1 pr-2 text-right">Neto</th>
            <th className="py-1 pr-2 text-right">21%</th>
            <th className="py-1 pr-2 text-right">10.5%</th>
            <th className="py-1 pr-2 text-right">27%</th>
            <th className="py-1 pr-2 text-right">Total</th>
            <th className="py-1 pr-2">Estado</th>
          </tr>
        </thead>
        <tbody>
          {data.kind === 'sales'
            ? data.salesRows.map((r) => (
                <tr key={r.saleId} className="border-b" style={{ pageBreakInside: 'avoid' }}>
                  <td className="py-1 pr-2">{formatDate(r.date)}</td>
                  <td className="py-1 pr-2">{r.type}</td>
                  <td className="py-1 pr-2">{r.number}</td>
                  <td className="py-1 pr-2">{r.customerName}</td>
                  <td className="py-1 pr-2">{r.customerCuit ?? ''}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.netAmount)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.vat21)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.vat105)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.vat27)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.total)}</td>
                  <td className="py-1 pr-2">{r.status === 'voided' ? 'ANULADA' : 'OK'}</td>
                </tr>
              ))
            : data.purchaseRows.map((r) => (
                <tr key={r.purchaseId} className="border-b" style={{ pageBreakInside: 'avoid' }}>
                  <td className="py-1 pr-2">{formatDate(r.date)}</td>
                  <td className="py-1 pr-2">{r.type}</td>
                  <td className="py-1 pr-2">{r.supplierInvoiceNumber}</td>
                  <td className="py-1 pr-2">{r.supplierName}</td>
                  <td className="py-1 pr-2">{r.supplierCuit ?? ''}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.netAmount)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.vat21)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.vat105)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.vat27)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(r.total)}</td>
                  <td className="py-1 pr-2">{r.status === 'voided' ? 'ANULADA' : 'OK'}</td>
                </tr>
              ))}
        </tbody>
        <tfoot>
          <tr className="border-t font-semibold">
            <td className="py-1 pr-2" colSpan={5}>TOTALES (excluye anuladas)</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(data.totals.net)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(data.totals.vat21)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(data.totals.vat105)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(data.totals.vat27)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(data.totals.total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      <div className="mt-4 text-[10px]">Emitido el {formatDateTime(printedAt)}</div>
    </div>
  )
}
