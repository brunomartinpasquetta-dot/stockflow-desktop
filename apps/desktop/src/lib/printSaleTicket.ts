/**
 * Impresión del ticket de una venta ya registrada, reutilizable desde el flujo
 * de venta (Ventas.tsx) y desde "Reimprimir" en Historial de Ventas.
 *
 * Camino PRINCIPAL (térmica del sistema, no A4): ESC/POS CRUDO al spooler del SO
 * (`api.hardware.printer.printSaleTicket`). Es el método estándar para térmicas
 * y NO usa el motor de impresión de Electron (que daba hoja en blanco). Es
 * silencioso de verdad. Si el usuario eligió diálogo, o no es térmica del
 * sistema, o el ESC/POS falla → `printNode` (window.print + diálogo del SO).
 */
import { createElement } from 'react'
import { toast } from 'sonner'

import { SaleTicket, type SaleTicketData } from '@/print/SaleTicket'
import { FormalDocA4, type FormalDocData } from '@/print/FormalDocA4'
import { printNode, widthFromPaperFormat } from '@/lib/printService'
import { formatDateTime } from '@/lib/format'
import { api } from '@/lib/api'
import type { PrinterConfigDTO, SaleTicketDataDTO, VoucherType } from '@/types/api'

const VOUCHER_LABELS: Record<VoucherType, string> = {
  A: 'Factura A',
  B: 'Factura B',
  C: 'Factura C',
  X: 'Remito X',
}

/** Mapea el ticket de venta al documento formal A4 (cuando el formato es A4). */
function toFormalDocFromSale(data: SaleTicketData): FormalDocData {
  const meta: FormalDocData['meta'] = [{ label: 'Fecha', value: formatDateTime(data.sale.date) }]
  if (data.sellerName) meta.push({ label: 'Vendedor', value: data.sellerName })
  const single = data.payments.length === 1 ? data.payments[0]!.methodName : null
  const esFacturaA = data.sale.type === 'A'

  // DETALLE DE ALÍCUOTAS: se arma agrupando los renglones por tasa. Sólo en la
  // Factura A, que es donde el IVA se discrimina. El neto de cada renglón sale
  // de sacarle el impuesto al importe cuando los precios se cargan CON IVA
  // (`priceMode: 'gross'`, que es como trabaja el comercio); si se cargan netos,
  // el importe YA es el neto.
  const vatBreakdown = esFacturaA
    ? [
        ...data.lines
          .reduce((acc, l) => {
            const rate = Number(l.vatRate ?? 0)
            if (!Number.isFinite(rate)) return acc
            const importe = Number(l.lineTotal)
            const base = data.priceMode === 'gross' ? importe / (1 + rate / 100) : importe
            const prev = acc.get(rate) ?? { base: 0, amount: 0 }
            acc.set(rate, { base: prev.base + base, amount: prev.amount + base * (rate / 100) })
            return acc
          }, new Map<number, { base: number; amount: number }>())
          .entries(),
      ]
        .sort((a, b) => a[0] - b[0])
        .map(([rate, v]) => ({
          rate: String(rate),
          base: v.base.toFixed(2),
          amount: v.amount.toFixed(2),
        }))
    : null

  return {
    company: data.company,
    // Un comprobante fiscal SIN CAE no es una factura válida: el título lo
    // dice, para que nadie entregue un papel que aparenta serlo.
    title:
      data.sale.type !== 'X' && !data.fiscal?.cae
        ? `${VOUCHER_LABELS[data.sale.type].toUpperCase()} — SIN AUTORIZAR (documento no válido)`
        : VOUCHER_LABELS[data.sale.type].toUpperCase(),
    number: String(data.sale.number).padStart(8, '0'),
    meta,
    customer: data.customerName
      ? { name: data.customerName, doc: data.customerDoc, vatCondition: data.customerVatCondition }
      : null,
    // ORIGINAL sólo en comprobantes fiscales: en un remito X no significa nada.
    copyLabel: data.sale.type !== 'X' ? 'Original' : null,
    saleCondition: data.isAccountSale ? 'Cuenta corriente' : (single ?? 'Contado'),
    vatBreakdown,
    lines: data.lines,
    totals: {
      subtotal: data.sale.subtotal,
      discount: data.sale.discount,
      vatAmount: data.sale.vatAmount,
      vatLabel: data.priceMode === 'gross' && data.sale.type !== 'A' ? 'IVA (incluido)' : 'IVA',
      total: data.sale.total,
    },
    payments: data.isAccountSale || data.payments.length <= 1 ? undefined : data.payments,
    paymentNote: data.isAccountSale ? 'Cuenta corriente' : single,
    // El pie fiscal (CAE + QR) NO se pasaba: el A4 salía sin ellos aunque la
    // venta estuviera facturada. Un comprobante fiscal sin CAE no es válido.
    fiscal: data.fiscal?.cae
      ? {
          cae: data.fiscal.cae,
          caeExpiry: data.fiscal.caeExpiry
            ? new Date(data.fiscal.caeExpiry).toLocaleDateString('es-AR')
            : null,
          qrDataUrl: data.fiscal.qrDataUrl ?? null,
          letter: data.fiscal.letter,
        }
      : null,
    // Leyendas al pie. Sólo en comprobantes fiscales: un remito X no las lleva.
    legalNotes:
      data.sale.type !== 'X'
        ? [
            'Los importes consignados en este comprobante incluyen los impuestos correspondientes según la condición fiscal del emisor.',
            'Reclamos por diferencias o faltantes dentro de las 48 horas de recibida la mercadería.',
          ]
        : null,
    footerNote: '¡Gracias por su compra!',
  }
}

/**
 * Mapea el ticket del renderer (SaleTicketData, pensado para el componente React)
 * al DTO que consume el motor ESC/POS del main (`hardware:printer:print-sale-ticket`).
 */
export function toEscPosTicketDTO(data: SaleTicketData): SaleTicketDataDTO {
  return {
    number: data.sale.number,
    voucherType: data.sale.type,
    createdAt: data.sale.date,
    company: {
      name: data.company.name,
      cuit: data.company.cuit,
      address: data.company.address,
      phone: data.company.phone,
      ingBrutos: data.company.ingBrutos,
    },
    customer: data.customerName ? { name: data.customerName, docNumber: data.customerDoc } : null,
    lines: data.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      total: l.lineTotal,
    })),
    subtotal: data.sale.subtotal,
    vatTotal: data.sale.vatAmount,
    total: data.sale.total,
    payments: data.payments.map((p) => ({ method: p.methodName, amount: p.amount })),
    accountSale: data.isAccountSale,
    fiscalCae: data.fiscal?.cae ?? null,
    fiscalCaeExpiry: data.fiscal?.caeExpiry ?? null,
  }
}

export async function printSaleTicketSilent(
  ticketData: SaleTicketData,
  printerCfg: PrinterConfigDTO | null,
): Promise<void> {
  const isA4 = printerCfg?.paperFormat === 'A4'
  const ticketWidth = widthFromPaperFormat(printerCfg?.paperFormat) === '80' ? '80' : '58'
  const useDialog = printerCfg?.silentPrint === false
  // En A4 imprimimos el documento FORMAL (marco, tabla, totales) que ocupa la
  // hoja; en 58/80 el ticket térmico clásico.
  const printViaDialog = (): Promise<void> =>
    isA4
      ? printNode(createElement(FormalDocA4, { data: toFormalDocFromSale(ticketData) }), 'a4')
      : printNode(createElement(SaleTicket, { data: ticketData }), ticketWidth)
  try {
    // Térmica del sistema configurada y modo directo → ESC/POS crudo (silent real).
    if (!useDialog && printerCfg?.kind === 'system' && printerCfg.paperFormat !== 'A4') {
      try {
        await api.hardware.printer.printSaleTicket(toEscPosTicketDTO(ticketData))
        return
      } catch (escErr) {
        // RAW falló, driver no ESC/POS, o sin impresora → caemos al diálogo.
        console.warn('Impresión ESC/POS falló, uso diálogo del SO:', escErr)
      }
    }
    await printViaDialog()
  } catch (err) {
    toast.error(
      err instanceof Error ? `No se pudo imprimir: ${err.message}` : 'No se pudo imprimir el ticket',
    )
  }
}
