/**
 * Helpers de exportación a Excel con fórmulas SUM (compatibles con contadores).
 * Estilos no aplican en xlsx community; el estado de anuladas viaja como texto.
 */
import * as XLSX from 'xlsx'

import type { VatBookPurchaseRowDTO, VatBookSaleRowDTO } from '@/types/api'
import { formatDate } from '@/lib/format'

function periodLabel(period: { from: number; to: number }): string {
  return `${formatDate(period.from)} a ${formatDate(period.to)}`
}

function ymd(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function exportVatBookSalesToExcel(
  rows: VatBookSaleRowDTO[],
  period: { from: number; to: number },
  companyName: string,
): void {
  const headerRows: (string | number)[][] = [
    [companyName],
    [`Libro IVA Ventas — período: ${periodLabel(period)}`],
    [],
    ['Fecha', 'Tipo', 'N°', 'Cliente', 'CUIT', 'Neto', 'IVA 21%', 'IVA 10.5%', 'IVA 27%', 'Total', 'Estado'],
  ]
  const dataStart = headerRows.length + 1 // 1-indexed
  const dataRows = rows.map((r) => [
    formatDate(r.date),
    r.type,
    r.number,
    r.customerName,
    r.customerCuit ?? '',
    r.status === 'voided' ? 0 : Number(r.netAmount),
    r.status === 'voided' ? 0 : Number(r.vat21),
    r.status === 'voided' ? 0 : Number(r.vat105),
    r.status === 'voided' ? 0 : Number(r.vat27),
    r.status === 'voided' ? 0 : Number(r.total),
    r.status === 'voided' ? 'ANULADA' : r.status === 'pending' ? 'Pendiente' : 'OK',
  ])
  const dataEnd = dataStart + dataRows.length - 1
  const aoa: (string | number)[][] = [...headerRows, ...dataRows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  if (dataRows.length > 0) {
    const totalRow = dataEnd + 1
    const sumCol = (col: string) => ({ t: 'n', f: `SUM(${col}${dataStart}:${col}${dataEnd})` })
    XLSX.utils.sheet_add_aoa(ws, [['', '', '', '', 'TOTALES']], { origin: `A${totalRow}` })
    ws[`F${totalRow}`] = sumCol('F')
    ws[`G${totalRow}`] = sumCol('G')
    ws[`H${totalRow}`] = sumCol('H')
    ws[`I${totalRow}`] = sumCol('I')
    ws[`J${totalRow}`] = sumCol('J')
  }

  ws['!cols'] = [
    { wch: 12 },
    { wch: 6 },
    { wch: 10 },
    { wch: 32 },
    { wch: 16 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Libro IVA Ventas')
  XLSX.writeFile(wb, `libro-iva-ventas-${ymd(period.from)}.xlsx`)
}

export function exportVatBookPurchasesToExcel(
  rows: VatBookPurchaseRowDTO[],
  period: { from: number; to: number },
  companyName: string,
): void {
  const headerRows: (string | number)[][] = [
    [companyName],
    [`Libro IVA Compras — período: ${periodLabel(period)}`],
    [],
    ['Fecha', 'Tipo', 'N° comprobante', 'Proveedor', 'CUIT', 'Neto', 'IVA 21%', 'IVA 10.5%', 'IVA 27%', 'Total', 'Estado'],
  ]
  const dataStart = headerRows.length + 1
  const dataRows = rows.map((r) => [
    formatDate(r.date),
    r.type,
    r.supplierInvoiceNumber,
    r.supplierName,
    r.supplierCuit ?? '',
    r.status === 'voided' ? 0 : Number(r.netAmount),
    r.status === 'voided' ? 0 : Number(r.vat21),
    r.status === 'voided' ? 0 : Number(r.vat105),
    r.status === 'voided' ? 0 : Number(r.vat27),
    r.status === 'voided' ? 0 : Number(r.total),
    r.status === 'voided' ? 'ANULADA' : r.status === 'pending' ? 'Pendiente' : 'OK',
  ])
  const dataEnd = dataStart + dataRows.length - 1
  const aoa: (string | number)[][] = [...headerRows, ...dataRows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)

  if (dataRows.length > 0) {
    const totalRow = dataEnd + 1
    const sumCol = (col: string) => ({ t: 'n', f: `SUM(${col}${dataStart}:${col}${dataEnd})` })
    XLSX.utils.sheet_add_aoa(ws, [['', '', '', '', 'TOTALES']], { origin: `A${totalRow}` })
    ws[`F${totalRow}`] = sumCol('F')
    ws[`G${totalRow}`] = sumCol('G')
    ws[`H${totalRow}`] = sumCol('H')
    ws[`I${totalRow}`] = sumCol('I')
    ws[`J${totalRow}`] = sumCol('J')
  }

  ws['!cols'] = [
    { wch: 12 },
    { wch: 6 },
    { wch: 16 },
    { wch: 32 },
    { wch: 16 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 12 },
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Libro IVA Compras')
  XLSX.writeFile(wb, `libro-iva-compras-${ymd(period.from)}.xlsx`)
}
