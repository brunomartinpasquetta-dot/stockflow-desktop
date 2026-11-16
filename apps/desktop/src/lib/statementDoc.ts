/**
 * RESUMEN DE CUENTA CORRIENTE en PDF — el que se le manda al cliente.
 *
 * Hasta ahora sólo se podía exportar el recibo de UNA cobranza puntual
 * (`receiptDoc.ts`), pero no el estado de la cuenta: qué compró, qué entregó y
 * cuánto debe. Eso es justamente lo que un comercio manda por WhatsApp cuando
 * quiere que le paguen.
 *
 * Se respeta el rango de fechas que el usuario tenga puesto en pantalla: si
 * filtró, el PDF sale filtrado y lo dice, con el saldo anterior al período
 * arriba para que la cuenta cierre igual.
 */
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

import { formatCurrency, formatDate } from '@/lib/format'
import type { CompanyDTO, CustomerDTO, StatementEntryDTO } from '@/types/api'

export interface StatementDocData {
  company: Pick<CompanyDTO, 'name' | 'address' | 'phone' | 'cuit'>
  customer: Pick<CustomerDTO, 'lastName' | 'firstName' | 'docType' | 'docNumber' | 'address' | 'phone' | 'mobile'>
  entries: StatementEntryDTO[]
  /** Saldo final de la cuenta (no del período). */
  balance: string
  /** Rango aplicado en pantalla, si el usuario filtró. */
  range?: { from: number; to: number } | null
}

const nombreDe = (c: StatementDocData['customer']): string =>
  `${c.lastName}${c.firstName ? ` ${c.firstName}` : ''}`.trim()

function etiqueta(e: StatementEntryDTO): string {
  if (e.kind === 'payment') {
    const base = e.paymentMethodName ? `Entrega — ${e.paymentMethodName}` : 'Entrega de dinero'
    return e.voided ? `${base} (anulada)` : base
  }
  // La anulación vuelve a cargar la deuda: para el cliente es la entrega que se
  // deshizo, con el motivo si lo hay.
  if (e.kind === 'void') return e.reference.replace(/^Anulación de cobranza/, 'Anulación de entrega')
  // `reference` ya dice «Devolución DEV #N».
  if (e.kind === 'return') return e.reference || 'Devolución'
  return e.reference || 'Comprobante'
}

/** Arma el PDF y lo descarga. */
export function exportStatementPdf(data: StatementDocData): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const c = data.company
  const cliente = nombreDe(data.customer)
  let y = 16

  doc.setFontSize(15).setFont('helvetica', 'bold')
  doc.text(c.name || 'StockFlow', 14, y)
  doc.setFontSize(9).setFont('helvetica', 'normal')
  for (const line of [c.address, c.phone && `Tel: ${c.phone}`, c.cuit && `CUIT: ${c.cuit}`].filter(
    Boolean,
  ) as string[]) {
    y += 4.5
    doc.text(line, 14, y)
  }

  doc.setFontSize(13).setFont('helvetica', 'bold')
  doc.text('RESUMEN DE CUENTA', 200, 18, { align: 'right' })
  doc.setFontSize(9).setFont('helvetica', 'normal')
  doc.text('DOCUMENTO NO FISCAL', 200, 23.5, { align: 'right' })
  doc.text(`Emitido el ${formatDate(Date.now())}`, 200, 28.5, { align: 'right' })

  y = Math.max(y, 30) + 8
  doc.setDrawColor(180).line(14, y, 200, y)
  y += 6

  doc.setFontSize(10).setFont('helvetica', 'bold')
  doc.text(`Cliente: ${cliente}`, 14, y)
  doc.setFont('helvetica', 'normal')
  const datos = [
    data.customer.docNumber && `${data.customer.docType ?? 'Doc'} ${data.customer.docNumber}`,
    data.customer.address,
    data.customer.mobile ?? data.customer.phone,
  ].filter(Boolean) as string[]
  for (const line of datos) {
    y += 5
    doc.text(line, 14, y)
  }
  if (data.range) {
    y += 5
    doc.text(
      `Período: ${formatDate(data.range.from)} al ${formatDate(data.range.to)}`,
      14,
      y,
    )
  }

  // Con el período filtrado, el saldo con el que ARRANCA la cuenta se calcula
  // hacia atrás desde el primer movimiento del rango: sin esto los renglones no
  // cierran contra el saldo final y el cliente desconfía del resumen.
  const primero = data.entries[0]
  const saldoAnterior = primero
    ? Number(primero.runningBalance) - Number(primero.debit) + Number(primero.credit)
    : 0

  // Cada venta se abre en SUS ARTÍCULOS, en renglones sangrados debajo del
  // comprobante. Un resumen que sólo dice "Venta B #1234 — $48.500" no le sirve
  // al cliente que pregunta qué se le está cobrando, que es justo cuando pide
  // el resumen. Los importes de esos renglones van en la columna de detalle:
  // las columnas Compras/Entregas/Saldo son sólo del movimiento, para que la
  // cuenta siga cerrando.
  // Las ENTREGAS van listadas una por una, con fecha y medio de pago, y el
  // saldo después de cada movimiento (Bruno, 12-nov-2026: «que se incluyan las
  // entregas que realizó el cliente»). Hasta la 1.18.4 iban sólo sumadas abajo,
  // por un pedido de un comercio de ago-2026; el cliente que recibe el resumen
  // quiere ver también qué pagó y cuándo, y así la cuenta cierra renglón a
  // renglón. Una entrega anulada se muestra marcada y su anulación es otro
  // renglón: la cuenta queda igual que en pantalla.
  type Celda = string | { content: string; styles?: Record<string, unknown> }
  const body: Celda[][] = []
  for (const e of data.entries) {
    const apagada = e.kind === 'payment' && e.voided
    const fila = (texto: string): Celda => (apagada ? { content: texto, styles: { textColor: 150 } } : texto)
    // La anulación de una entrega va en la columna Entregas, en negativo: bajo
    // «Compras» el cliente la leería como algo que se le cobró.
    // El signo va adelante a mano: según el sistema, Intl escribe «$-2.000,00».
    const colCompras = e.kind === 'void' ? '' : Number(e.debit) ? formatCurrency(e.debit) : ''
    const colEntregas = e.kind === 'void' ? `-${formatCurrency(e.debit)}` : Number(e.credit) ? formatCurrency(e.credit) : ''
    body.push([
      fila(formatDate(e.date)),
      fila(etiqueta(e)),
      fila(colCompras),
      fila(colEntregas),
      fila(formatCurrency(e.runningBalance)),
    ])
    for (const a of e.articles ?? []) {
      const cant = Number(a.quantity)
      const cantTxt = Number.isInteger(cant) ? String(cant) : String(cant)
      body.push([
        '',
        {
          content: `      ${cantTxt} × ${a.description} — ${formatCurrency(a.unitPrice)} c/u = ${formatCurrency(a.lineTotal)}`,
          styles: { fontSize: 7.5, textColor: 110 },
        },
        '',
        '',
        '',
      ])
    }
  }
  if (data.range && Math.abs(saldoAnterior) > 0.005) {
    body.unshift(['', 'Saldo anterior', '', '', formatCurrency(String(saldoAnterior))])
  }

  autoTable(doc, {
    startY: y + 5,
    head: [['Fecha', 'Detalle', 'Compras', 'Entregas', 'Saldo']],
    body,
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: [27, 82, 204] },
    columnStyles: {
      0: { cellWidth: 20 },
      2: { halign: 'right', cellWidth: 27 },
      3: { halign: 'right', cellWidth: 27 },
      4: { halign: 'right', cellWidth: 29 },
    },
    margin: { left: 14, right: 10 },
  })
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8

  // Totales del período listado. Las entregas van NETAS de anulaciones y las
  // devoluciones aparte, así Compras − Entregas − Devoluciones = Saldo cierra
  // con lo que se ve arriba.
  const suma = (f: (e: StatementEntryDTO) => number) => data.entries.reduce((a, e) => a + f(e), 0)
  const compras = suma((e) => (e.kind === 'sale' ? Number(e.debit) : 0))
  const entregas =
    suma((e) => (e.kind === 'payment' ? Number(e.credit) : 0)) - suma((e) => (e.kind === 'void' ? Number(e.debit) : 0))
  const devoluciones = suma((e) => (e.kind === 'return' ? Number(e.credit) : 0))
  doc.setFontSize(9).setFont('helvetica', 'normal')
  doc.text(
    [
      `Compras: ${formatCurrency(String(compras))}`,
      `Entregas a cuenta: ${formatCurrency(String(entregas))}`,
      devoluciones > 0.005 ? `Devoluciones: ${formatCurrency(String(devoluciones))}` : '',
    ]
      .filter(Boolean)
      .join('   ·   '),
    14,
    y,
  )

  y += 9
  doc.setFontSize(13).setFont('helvetica', 'bold')
  doc.text('SALDO ADEUDADO', 14, y)
  doc.text(formatCurrency(data.balance), 200, y, { align: 'right' })

  y += 8
  doc.setFontSize(8).setFont('helvetica', 'normal').setTextColor(110)
  doc.text('Documento no fiscal — resumen de cuenta corriente', 14, y)

  const quien = cliente.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 30)
  doc.save(`resumen-cuenta-${quien}-${new Date().toISOString().slice(0, 10)}.pdf`)
}

/**
 * Mismo resumen, en Excel. El comercio lo usa para conciliar o para mandarlo a
 * quien lleva la contabilidad: por eso los importes van como NÚMEROS, no como
 * texto con signo pesos — si no, no se pueden sumar del otro lado.
 */
export async function exportStatementExcel(data: StatementDocData): Promise<void> {
  const XLSX = await import('xlsx')
  const cliente = nombreDe(data.customer)

  const encabezado: (string | number)[][] = [
    [data.company.name || 'StockFlow'],
    ['Resumen de cuenta corriente'],
    [`Cliente: ${cliente}`],
  ]
  if (data.customer.docNumber) {
    encabezado.push([`${data.customer.docType ?? 'Doc'}: ${data.customer.docNumber}`])
  }
  if (data.range) {
    encabezado.push([`Período: ${formatDate(data.range.from)} al ${formatDate(data.range.to)}`])
  }
  encabezado.push([`Emitido el ${formatDate(Date.now())}`], [])

  const ws = XLSX.utils.aoa_to_sheet(encabezado)
  XLSX.utils.sheet_add_aoa(ws, [['Fecha', 'Detalle', 'Debe', 'Haber', 'Saldo']], {
    origin: -1,
  })
  XLSX.utils.sheet_add_aoa(
    ws,
    data.entries.map((e) => [
      formatDate(e.date),
      etiqueta(e),
      Number(e.debit) || 0,
      Number(e.credit) || 0,
      Number(e.runningBalance) || 0,
    ]),
    { origin: -1 },
  )
  XLSX.utils.sheet_add_aoa(ws, [[], ['', 'SALDO ADEUDADO', '', '', Number(data.balance) || 0]], {
    origin: -1,
  })

  ws['!cols'] = [{ wch: 12 }, { wch: 44 }, { wch: 14 }, { wch: 14 }, { wch: 16 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Resumen de cuenta')
  const quien = cliente.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 30)
  XLSX.writeFile(wb, `resumen-cuenta-${quien}-${new Date().toISOString().slice(0, 10)}.xlsx`)
}
