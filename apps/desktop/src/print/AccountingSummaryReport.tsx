/**
 * Reporte impreso del Resumen Contable (A4 vertical).
 */
import { useState } from 'react'

import type { CompanyDTO, FinancialSummaryDTO } from '@/types/api'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'

export interface AccountingSummaryReportData {
  company: CompanyDTO
  summary: FinancialSummaryDTO
}

export function AccountingSummaryReport({ data }: { data: AccountingSummaryReportData }) {
  const { company, summary } = data
  const [printedAt] = useState(() => Date.now())
  const grossNum = Number(summary.grossResult)
  const vatNum = Number(summary.vatPosition)

  return (
    <div className="print-a4">
      <div className="mb-3 border-b pb-2">
        <div className="text-lg font-bold uppercase">{company.name}</div>
        {company.address && <div className="text-xs">{company.address}</div>}
        {company.cuit && <div className="text-xs">CUIT: {company.cuit}</div>}
      </div>

      <h1 className="mb-1 text-base font-bold">Resumen Contable</h1>
      <div className="mb-3 text-xs">
        <div>Desde: {formatDate(summary.period.from)}</div>
        <div>Hasta: {formatDate(summary.period.to)}</div>
      </div>

      <table className="mb-3 w-full border-collapse text-xs">
        <tbody>
          <tr className="border-b">
            <td className="py-1 font-semibold">Activos totales</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.assets.total)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 pl-4">Artículos (stock × costo)</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.assets.articlesValue)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 pl-4">Efectivo en cajas abiertas</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.assets.cashValue)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 font-semibold">Ventas ({summary.sales.count})</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.sales.total)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 pl-4">IVA débito</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.sales.vatAmount)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 font-semibold">Compras ({summary.purchases.count})</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.purchases.total)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 pl-4">IVA crédito</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.purchases.vatAmount)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 font-semibold">CMV (costo de mercadería vendida)</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.cmv.total)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 font-semibold">Resultado bruto {grossNum < 0 ? '(PÉRDIDA)' : ''}</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.grossResult)}</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 pl-4">Margen bruto</td>
            <td className="py-1 text-right tabular-nums">{summary.grossMarginPct}%</td>
          </tr>
          <tr className="border-b">
            <td className="py-1 font-semibold">Posición IVA {vatNum > 0.005 ? '(saldo a pagar)' : vatNum < -0.005 ? '(saldo a favor)' : ''}</td>
            <td className="py-1 text-right tabular-nums">{formatCurrency(summary.vatPosition)}</td>
          </tr>
        </tbody>
      </table>

      <div className="text-[10px] text-muted-foreground">
        CMV calculado con costo actual de artículos (no histórico).
      </div>
      <div className="mt-4 text-[10px]">Emitido el {formatDateTime(printedAt)}</div>
    </div>
  )
}
