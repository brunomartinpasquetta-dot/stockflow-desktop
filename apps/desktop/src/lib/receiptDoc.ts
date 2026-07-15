/**
 * Recibos de cuenta corriente en formato A4 y PDF.
 *
 * - `receiptToFormalDoc`: mapea un `PaymentReceiptData` (el mismo del ticket
 *   térmico) al documento formal A4 → sirve para la VISTA PREVIA/impresión en
 *   hoja común (el ticket de 58 mm en una A4 se veía roto: ese era el bug).
 * - `exportReceiptPdf`: genera un `.pdf` real con jspdf (descarga directa,
 *   sin diálogo de impresión) — botón "Exportar PDF" en Acciones de CC.
 */
import { createElement } from 'react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'
import { printNode } from '@/lib/printService'
import { FormalDocA4, type FormalDocData } from '@/print/FormalDocA4'
import type { PaymentReceiptData } from '@/print/PaymentReceipt'

/** Mapea el recibo al documento formal A4 (vista previa / impresión en hoja). */
export function receiptToFormalDoc(data: PaymentReceiptData): FormalDocData {
  const lines = data.period
    ? data.period.lines.map((l) => ({
        description: `${formatDate(l.date)} — ${l.label}`,
        quantity: '',
        unitPrice: '',
        lineTotal: formatCurrency(l.amount),
      }))
    : [
        {
          description: data.comprobanteRef ? `Pago sobre ${data.comprobanteRef}` : 'Pago recibido',
          quantity: '',
          unitPrice: '',
          lineTotal: formatCurrency(data.amount),
        },
      ]

  const meta = [
    { label: 'Fecha', value: formatDateTime(data.date) },
    { label: 'Medio de pago', value: data.paymentMethod },
  ]
  if (data.period) {
    meta.push({ label: 'Período', value: `${formatDate(data.period.from)} al ${formatDate(data.period.to)}` })
  }
  if (data.comprobanteRef) meta.push({ label: 'Comprobante', value: data.comprobanteRef })

  const saldoNotes: string[] = []
  if (data.comprobanteBalance != null) saldoNotes.push(`Saldo del comprobante: ${formatCurrency(data.comprobanteBalance)}`)
  saldoNotes.push(`Saldo total de la cuenta: ${formatCurrency(data.accountBalance)}`)

  return {
    company: data.company,
    title: data.title ?? 'RECIBO DE COBRANZA',
    number: '',
    meta,
    customer: { name: data.customerName, doc: data.customerDoc },
    lines,
    totals: { subtotal: data.amount, total: data.amount },
    paymentNote: null,
    notes: saldoNotes.join('  ·  '),
    footerNote: 'Documento no fiscal — comprobante de pago',
  }
}

/** Vista previa / impresión del recibo en A4 (hoja común). */
export async function printReceiptA4(data: PaymentReceiptData): Promise<void> {
  await printNode(createElement(FormalDocA4, { data: receiptToFormalDoc(data) }), 'a4')
}

/** Exporta el recibo como archivo PDF (descarga directa, sin diálogo). */
export function exportReceiptPdf(data: PaymentReceiptData): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const c = data.company
  let y = 16

  doc.setFontSize(15).setFont('helvetica', 'bold')
  doc.text(c.name || 'StockFlow', 14, y)
  doc.setFontSize(9).setFont('helvetica', 'normal')
  const compLines = [c.address, c.phone && `Tel: ${c.phone}`, c.cuit && `CUIT: ${c.cuit}`].filter(Boolean) as string[]
  for (const line of compLines) {
    y += 4.5
    doc.text(line, 14, y)
  }

  doc.setFontSize(13).setFont('helvetica', 'bold')
  doc.text(data.title ?? 'RECIBO DE COBRANZA', 200, 18, { align: 'right' })
  doc.setFontSize(9).setFont('helvetica', 'normal')
  doc.text('DOCUMENTO NO FISCAL', 200, 23.5, { align: 'right' })
  doc.text(formatDateTime(data.date), 200, 28.5, { align: 'right' })

  y = Math.max(y, 30) + 8
  doc.setDrawColor(180).line(14, y, 200, y)
  y += 6
  doc.setFontSize(10).setFont('helvetica', 'bold')
  doc.text(`${data.partyLabel ?? 'Cliente'}: ${data.customerName}`, 14, y)
  doc.setFont('helvetica', 'normal')
  if (data.customerDoc) {
    y += 5
    doc.text(data.customerDoc, 14, y)
  }
  y += 5
  doc.text(`Medio de pago: ${data.paymentMethod}`, 14, y)
  if (data.comprobanteRef) {
    y += 5
    doc.text(`Comprobante: ${data.comprobanteRef}`, 14, y)
  }

  if (data.period) {
    y += 7
    doc.setFont('helvetica', 'bold')
    doc.text(`Detalle del período ${formatDate(data.period.from)} al ${formatDate(data.period.to)}`, 14, y)
    autoTable(doc, {
      startY: y + 2,
      head: [['Fecha', 'Detalle', 'Importe']],
      body: data.period.lines.map((l) => [formatDate(l.date), l.label, formatCurrency(l.amount)]),
      styles: { fontSize: 8.5, cellPadding: 1.6 },
      headStyles: { fillColor: [27, 82, 204] },
      columnStyles: { 2: { halign: 'right' } },
      margin: { left: 14, right: 10 },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4
    doc.setFontSize(9).setFont('helvetica', 'normal')
    doc.text(`Cargos del período: ${formatCurrency(data.period.charges)}   ·   Pagos del período: ${formatCurrency(data.period.payments)}`, 14, y)
    y += 4
  }

  y += 8
  doc.setFontSize(13).setFont('helvetica', 'bold')
  doc.text('ENTREGADO', 14, y)
  doc.text(formatCurrency(data.amount), 200, y, { align: 'right' })

  y += 8
  doc.setFontSize(10).setFont('helvetica', 'normal')
  if (data.comprobanteBalance != null) {
    doc.text(`Saldo del comprobante: ${formatCurrency(data.comprobanteBalance)}`, 14, y)
    y += 5
  }
  doc.setFont('helvetica', 'bold')
  doc.text(`Saldo total de la cuenta: ${formatCurrency(data.accountBalance)}`, 14, y)

  const iso = new Date(data.date).toISOString().slice(0, 10)
  const who = data.customerName.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 30)
  doc.save(`recibo-${who}-${iso}.pdf`)
}
