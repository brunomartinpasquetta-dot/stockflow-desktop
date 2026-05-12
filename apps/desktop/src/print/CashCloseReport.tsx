/**
 * Reporte de cierre de caja en formato A4 (resumen + detalle de movimientos).
 * Se imprime después de cerrar la caja: el `CashReportDTO` ya trae
 * `closingAmount` y `difference`.
 */
import { useState } from 'react'

import type { CashReportDTO, CompanyDTO } from '@/types/api'
import { formatCurrency, formatDateTime } from '@/lib/format'

export interface CashCloseReportData {
  company: CompanyDTO
  report: CashReportDTO
  /** Nombre del usuario que cierra la caja. */
  closedBy: string
}

function movementKind(m: CashReportDTO['movements'][number]): string {
  if (m.relatedSaleId) return m.type === 'income' ? 'Venta' : 'Anulación'
  if (m.relatedPurchaseId) return 'Compra'
  if (m.description.toLowerCase().startsWith('cobranza')) return 'Cobro'
  return m.type === 'income' ? 'Ingreso' : 'Egreso'
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between border-b border-dotted py-0.5${strong ? ' font-bold' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}

export function CashCloseReport({ data }: { data: CashCloseReportData }) {
  const { company, report, closedBy } = data
  const [printedAt] = useState(() => Date.now())
  const r = report.register
  const diff = report.difference ?? '0'
  const diffNum = Number(diff)
  const movements = [...report.movements].sort((a, b) => a.date - b.date)
  return (
    <div className="print-a4">
      <div className="mb-3 border-b pb-2">
        <div className="text-lg font-bold uppercase">{company.name}</div>
        {company.address && <div className="text-xs">{company.address}</div>}
        {company.cuit && <div className="text-xs">CUIT: {company.cuit}</div>}
      </div>

      <h1 className="mb-1 text-base font-bold">Reporte de cierre de caja</h1>
      <div className="mb-3 text-xs">
        <div>Caja #{r.number}</div>
        <div>Apertura: {formatDateTime(r.openDate)}</div>
        <div>Cierre: {r.closeDate ? formatDateTime(r.closeDate) : '—'}</div>
        <div>Cajero: {closedBy}</div>
      </div>

      <div className="mb-4 max-w-md text-sm">
        <Row label="Monto inicial (apertura)" value={formatCurrency(report.openingAmount)} />
        <Row label={`Ingresos totales (${report.incomeCount})`} value={formatCurrency(report.incomeTotal)} />
        <Row label={`Egresos totales (${report.expenseCount})`} value={formatCurrency(report.expenseTotal)} />
        <Row label="Efectivo esperado en el cajón" value={formatCurrency(report.expectedCash)} strong />
        <Row label="Efectivo contado" value={formatCurrency(report.closingAmount ?? '0')} />
        <Row
          label="Diferencia"
          value={`${diffNum < 0 ? 'Faltante ' : diffNum > 0 ? 'Sobrante ' : ''}${formatCurrency(Math.abs(diffNum))}`}
          strong
        />
        <div className="mt-1 flex justify-between text-xs text-gray-600">
          <span>Ventas del período ({report.salesCount})</span>
          <span className="tabular-nums">{formatCurrency(report.salesTotal)}</span>
        </div>
      </div>

      <h2 className="mb-1 text-sm font-bold">Desglose por medio de pago</h2>
      <table className="mb-4 w-full max-w-lg border-collapse text-xs">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1 pr-2">Medio</th>
            <th className="py-1 pr-2 text-right">Ingresos</th>
            <th className="py-1 pr-2 text-right">Egresos</th>
            <th className="py-1 text-right">Neto</th>
          </tr>
        </thead>
        <tbody>
          {report.byPaymentMethod.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-2 text-center text-gray-500">Sin movimientos</td>
            </tr>
          ) : (
            report.byPaymentMethod.map((b) => (
              <tr key={b.paymentMethodId ?? '__none__'} className="border-b border-dotted">
                <td className="py-0.5 pr-2">
                  {b.name}
                  {b.isPhysicalCash ? ' (efectivo físico)' : ''}
                </td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{formatCurrency(b.incomeTotal)}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{formatCurrency(b.expenseTotal)}</td>
                <td className="py-0.5 text-right tabular-nums font-medium">{formatCurrency(b.net)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h2 className="mb-1 text-sm font-bold">Movimientos del período</h2>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1 pr-2">Hora</th>
            <th className="py-1 pr-2">Tipo</th>
            <th className="py-1 pr-2">Descripción</th>
            <th className="py-1 pr-2 text-right">Ingreso</th>
            <th className="py-1 text-right">Egreso</th>
          </tr>
        </thead>
        <tbody>
          {movements.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-2 text-center text-gray-500">
                Sin movimientos
              </td>
            </tr>
          ) : (
            movements.map((m) => (
              <tr key={m.id} className="border-b border-dotted">
                <td className="py-0.5 pr-2 whitespace-nowrap">{formatDateTime(m.date)}</td>
                <td className="py-0.5 pr-2 whitespace-nowrap">
                  {movementKind(m)}
                  {m.relatedSaleStatus === 'voided' && m.type === 'income' ? ' (ANULADA)' : ''}
                </td>
                <td className="py-0.5 pr-2">{m.description}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{m.type === 'income' ? formatCurrency(m.amount) : ''}</td>
                <td className="py-0.5 text-right tabular-nums">{m.type === 'expense' ? formatCurrency(m.amount) : ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {r.notes && (
        <div className="mt-4 text-xs">
          <div className="font-bold">Observaciones</div>
          <div className="whitespace-pre-line">{r.notes}</div>
        </div>
      )}

      <div className="mt-6 text-[10px] text-gray-500">Impreso el {formatDateTime(printedAt)}</div>
    </div>
  )
}
