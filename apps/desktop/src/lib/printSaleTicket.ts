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
import { printNode, widthFromPaperFormat } from '@/lib/printService'
import { api } from '@/lib/api'
import type { PrinterConfigDTO, SaleTicketDataDTO } from '@/types/api'

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
  }
}

export async function printSaleTicketSilent(
  ticketData: SaleTicketData,
  printerCfg: PrinterConfigDTO | null,
): Promise<void> {
  const ticketWidth = widthFromPaperFormat(printerCfg?.paperFormat) === '80' ? '80' : '58'
  const useDialog = printerCfg?.silentPrint === false
  const printViaDialog = (): Promise<void> =>
    printNode(createElement(SaleTicket, { data: ticketData }), ticketWidth)
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
