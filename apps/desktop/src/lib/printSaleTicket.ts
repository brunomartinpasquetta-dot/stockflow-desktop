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
    customer: data.customerName ? { name: data.customerName, doc: data.customerDoc } : null,
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
