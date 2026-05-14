/**
 * Reporte impreso del Historial de Cajas en un rango (A4 vertical):
 * lista todas las cajas del período con totales agregados.
 */
import { useState } from 'react'

import type { CompanyDTO, HistoricalCashRegisterDTO } from '@/types/api'
import { formatCurrency, formatDateTime } from '@/lib/format'

export interface HistoricalCashReportData {
  company: CompanyDTO
  from: number
  to: number
  userName?: string
  registers: HistoricalCashRegisterDTO[]
}

function sumStr(values: (string | null | undefined)[]): number {
  return values.reduce<number>((acc, v) => acc + (v == null ? 0 : Number(v)), 0)
}

function statusLabel(r: HistoricalCashRegisterDTO): string {
  if (r.status === 'open') return 'Abierta'
  const diff = Number(r.difference ?? '0')
  if (diff > 0.005) return `Sobrante ${formatCurrency(diff)}`
  if (diff < -0.005) return `Faltante ${formatCurrency(Math.abs(diff))}`
  return 'Cerrada'
}

export function HistoricalCashReport({ data }: { data: HistoricalCashReportData }) {
  const { company, from, to, userName, registers } = data
  const [printedAt] = useState(() => Date.now())
  const totalIncome = sumStr(registers.map((r) => r.totalIncome))
  const totalExpense = sumStr(registers.map((r) => r.totalExpense))
  const totalOpening = sumStr(registers.map((r) => r.openingAmount))
  return (
    <div className="print-a4">
      <div className="mb-3 border-b pb-2">
        <div className="text-lg font-bold uppercase">{company.name}</div>
        {company.address && <div className="text-xs">{company.address}</div>}
        {company.cuit && <div className="text-xs">CUIT: {company.cuit}</div>}
      </div>

      <h1 className="mb-1 text-base font-bold">Historial de cajas</h1>
      <div className="mb-3 text-xs">
        <div>Desde: {formatDateTime(from)}</div>
        <div>Hasta: {formatDateTime(to)}</div>
        {userName && <div>Cajero: {userName}</div>}
        <div>Cajas en el período: {registers.length}</div>
      </div>

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1 pr-2">N°</th>
            <th className="py-1 pr-2">Apertura</th>
            <th className="py-1 pr-2">Cierre</th>
            <th className="py-1 pr-2">Cajero</th>
            <th className="py-1 pr-2 text-right">Apertura</th>
            <th className="py-1 pr-2 text-right">Ingresos</th>
            <th className="py-1 pr-2 text-right">Egresos</th>
            <th className="py-1 pr-2 text-right">Esperado</th>
            <th className="py-1 pr-2 text-right">Cierre</th>
            <th className="py-1 pr-2 text-right">Diferencia</th>
            <th className="py-1 pr-2">Estado</th>
          </tr>
        </thead>
        <tbody>
          {registers.length === 0 ? (
            <tr>
              <td colSpan={11} className="py-2 text-center text-gray-500">Sin cajas en el rango</td>
            </tr>
          ) : (
            registers.map((r) => (
              <tr key={r.id} className="border-b border-dotted">
                <td className="py-0.5 pr-2 tabular-nums">{r.number}</td>
                <td className="py-0.5 pr-2 whitespace-nowrap">{formatDateTime(r.openDate)}</td>
                <td className="py-0.5 pr-2 whitespace-nowrap">{r.closeDate ? formatDateTime(r.closeDate) : '—'}</td>
                <td className="py-0.5 pr-2">{r.userName}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{formatCurrency(r.openingAmount)}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{formatCurrency(r.totalIncome)}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{formatCurrency(r.totalExpense)}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{r.expectedAmount ? formatCurrency(r.expectedAmount) : '—'}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{r.closingAmount ? formatCurrency(r.closingAmount) : '—'}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{r.difference ? formatCurrency(r.difference) : '—'}</td>
                <td className="py-0.5 pr-2">{statusLabel(r)}</td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot>
          <tr className="border-t font-bold">
            <td colSpan={4} className="py-1 pr-2">Totales</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(totalOpening)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(totalIncome)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(totalExpense)}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{formatCurrency(totalIncome - totalExpense)}</td>
            <td colSpan={3} />
          </tr>
        </tfoot>
      </table>

      <div className="mt-6 text-[10px] text-gray-500">Impreso el {formatDateTime(printedAt)}</div>
    </div>
  )
}
