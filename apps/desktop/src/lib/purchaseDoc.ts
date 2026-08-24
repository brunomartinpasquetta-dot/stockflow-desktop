/**
 * DOCUMENTO DE UNA COMPRA — PDF A4 para imprimir o archivar.
 *
 * Es un documento INTERNO (control de mercadería recibida, respaldo del
 * costo), no un comprobante fiscal: el comprobante fiscal de una compra lo
 * emite el PROVEEDOR. Por eso lleva el rótulo de documento no fiscal.
 *
 * Mismo estilo que el resumen de cuenta (`statementDoc.ts`): jsPDF directo,
 * sin pasar por la impresión del navegador para el PDF; para imprimir se abre
 * el mismo PDF en un iframe y se manda al diálogo del sistema.
 */
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

import { formatCurrency, formatDateTime } from '@/lib/format'
import type { CompanyDTO, PurchaseDTO, PurchaseLineDTO } from '@/types/api'

export interface PurchaseDocData {
  company: Pick<CompanyDTO, 'name' | 'address' | 'phone' | 'cuit'>
  purchase: PurchaseDTO
  supplierName: string
  /** Descripción por artículo (la línea no la trae). */
  lines: { line: PurchaseLineDTO; description: string }[]
  voucherLabel: string
}

function construir(data: PurchaseDocData): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const { company, purchase, supplierName, voucherLabel } = data
  let y = 16

  doc.setFontSize(15).setFont('helvetica', 'bold')
  doc.text(company.name || 'StockFlow', 14, y)
  doc.setFontSize(9).setFont('helvetica', 'normal')
  for (const linea of [company.address, company.phone && `Tel: ${company.phone}`, company.cuit && `CUIT: ${company.cuit}`].filter(Boolean) as string[]) {
    y += 4.5
    doc.text(linea, 14, y)
  }

  doc.setFontSize(13).setFont('helvetica', 'bold')
  doc.text('COMPRA', 200, 18, { align: 'right' })
  doc.setFontSize(9).setFont('helvetica', 'normal')
  doc.text(`${voucherLabel} N° ${purchase.number}`, 200, 23.5, { align: 'right' })
  doc.text(`Fecha: ${formatDateTime(purchase.date)}`, 200, 28.5, { align: 'right' })
  if (purchase.supplierInvoiceNumber) {
    doc.text(`Comprobante del proveedor: ${purchase.supplierInvoiceNumber}`, 200, 33.5, { align: 'right' })
  }

  y = Math.max(y, 35) + 8
  doc.setDrawColor(180).line(14, y, 200, y)
  y += 6
  doc.setFontSize(10).setFont('helvetica', 'bold')
  doc.text(`Proveedor: ${supplierName}`, 14, y)
  doc.setFont('helvetica', 'normal').setFontSize(9)
  y += 5
  doc.text(
    `Modalidad: ${purchase.paymentType === 'credit' ? 'Cuenta corriente del proveedor' : 'Contado'}` +
      (purchase.status === 'voided' ? '   ·   ANULADA' : ''),
    14,
    y,
  )

  autoTable(doc, {
    startY: y + 5,
    head: [['Producto', 'Cant.', 'Costo unit.', 'Subtotal']],
    body: data.lines.map(({ line, description }) => [
      description,
      String(Number(line.quantity)),
      formatCurrency(line.costPrice),
      formatCurrency(line.lineTotal),
    ]),
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: [27, 82, 204] },
    columnStyles: {
      1: { halign: 'right', cellWidth: 20 },
      2: { halign: 'right', cellWidth: 30 },
      3: { halign: 'right', cellWidth: 30 },
    },
    margin: { left: 14, right: 10 },
  })
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8

  doc.setFontSize(9).setFont('helvetica', 'normal')
  doc.text(`Subtotal: ${formatCurrency(purchase.subtotal)}`, 200, y, { align: 'right' })
  y += 4.5
  if (Number(purchase.discount) > 0) {
    doc.text(`Descuento: -${formatCurrency(purchase.discount)}`, 200, y, { align: 'right' })
    y += 4.5
  }
  doc.text(`IVA: ${formatCurrency(purchase.vatAmount)}`, 200, y, { align: 'right' })
  y += 7
  doc.setFontSize(13).setFont('helvetica', 'bold')
  doc.text('TOTAL', 140, y)
  doc.text(formatCurrency(purchase.total), 200, y, { align: 'right' })

  y += 9
  doc.setFontSize(8).setFont('helvetica', 'normal').setTextColor(110)
  doc.text('Documento interno de control — no válido como comprobante fiscal', 14, y)
  return doc
}

export function exportPurchasePdf(data: PurchaseDocData): void {
  const doc = construir(data)
  doc.save(`compra-${data.purchase.number}-${new Date(data.purchase.date).toISOString().slice(0, 10)}.pdf`)
}

/**
 * Imprime por el diálogo del sistema. El PDF se abre en un iframe oculto y se
 * dispara `print()` ahí: funciona igual en la app y en las terminales por
 * navegador, sin depender del CSS de impresión de la página.
 */
export function printPurchasePdf(data: PurchaseDocData): void {
  const doc = construir(data)
  const url = doc.output('bloburl')
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.src = String(url)
  frame.onload = () => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    // Se limpia recién a los 2 minutos: el diálogo de impresión usa el iframe
    // mientras está abierto y sacarlo antes corta la impresión.
    setTimeout(() => frame.remove(), 120_000)
  }
  document.body.appendChild(frame)
}
