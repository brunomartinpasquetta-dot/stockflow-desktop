/**
 * Impresión del ticket de una venta ya registrada, reutilizable desde el flujo
 * de venta (Ventas.tsx) y desde "Reimprimir" en Historial de Ventas.
 *
 * Silencioso (impresión directa): el ticket se HORNEA a HTML completo
 * (renderToString) y se imprime en una ventana OCULTA dedicada vía
 * webContents.print → el contenido viaja DENTRO del HTML, sin la carrera de
 * render del #print-area de la página viva (que salía en blanco). Si falla, o si
 * el usuario eligió el diálogo, usa `printNode` (window.print + diálogo del SO).
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
  const silent = printerCfg?.silentPrint !== false
  const deviceName =
    printerCfg?.kind === 'system' && printerCfg.interface.trim() ? printerCfg.interface.trim() : undefined
  const ticketFileName = `ticket-venta-${ticketData.sale.type}-${String(ticketData.sale.number).padStart(8, '0')}`
  const printViaDialog = (): Promise<void> =>
    printNode(createElement(SaleTicket, { data: ticketData }), ticketWidth)
  try {
    if (!silent) {
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
        const archivo = pdfPath ? pdfPath.split(/[/\\]/).pop() : `${ticketFileName}.pdf`
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
