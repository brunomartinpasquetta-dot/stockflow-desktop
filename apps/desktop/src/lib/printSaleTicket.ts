/**
 * Impresión del ticket de una venta ya registrada, reutilizable desde el flujo
 * de venta (Ventas.tsx) y desde "Reimprimir" en Historial de Ventas.
 *
 * Respeta el toggle de Configuración:
 *  - `silentPrint === false` → diálogo del SO (`printNode` = window.print),
 *    el MISMO mecanismo que "Probar impresión".
 *  - cualquier otro valor (default) → impresión automática sin diálogo
 *    (`autoPrintTicket`: Windows vía webContents.print silencioso; mac/linux vía
 *    lp/CUPS). Si falla, cae al diálogo del SO para que el ticket salga igual.
 *    Si no hay NINGUNA impresora, el PDF queda en el Escritorio (warning).
 */
import { createElement } from 'react'
import { toast } from 'sonner'

import { SaleTicket, type SaleTicketData } from '@/print/SaleTicket'
import { autoPrintTicket, printNode, widthFromPaperFormat } from '@/lib/printService'
import type { PrinterConfigDTO } from '@/types/api'

export async function printSaleTicketSilent(
  ticketData: SaleTicketData,
  printerCfg: PrinterConfigDTO | null,
): Promise<void> {
  const ticketWidth = widthFromPaperFormat(printerCfg?.paperFormat) === '80' ? '80' : '58'
  const ticketFileName = `ticket-venta-${ticketData.sale.type}-${String(ticketData.sale.number).padStart(8, '0')}`
  const useDialog = printerCfg?.silentPrint === false
  const deviceName =
    printerCfg?.kind === 'system' && printerCfg.interface.trim() ? printerCfg.interface.trim() : undefined
  const printViaDialog = (): Promise<void> =>
    printNode(createElement(SaleTicket, { data: ticketData }), ticketWidth)
  try {
    if (useDialog) {
      await printViaDialog()
      return
    }
    try {
      const { printed, pdfPath } = await autoPrintTicket(
        createElement(SaleTicket, { data: ticketData }),
        ticketWidth,
        ticketFileName,
        deviceName,
      )
      if (!printed) {
        const archivo = pdfPath ? pdfPath.split('/').pop() : `${ticketFileName}.pdf`
        toast.warning(`No se detectó impresora. El ticket se guardó en el Escritorio: ${archivo}`)
      }
    } catch (autoErr) {
      console.warn('Impresión automática falló, uso diálogo del SO:', autoErr)
      await printViaDialog()
    }
  } catch (err) {
    toast.error(
      err instanceof Error ? `No se pudo imprimir: ${err.message}` : 'No se pudo imprimir el ticket',
    )
  }
}
