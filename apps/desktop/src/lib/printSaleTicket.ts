/**
 * Impresión del ticket de una venta ya registrada, reutilizable desde el flujo
 * de venta (Ventas.tsx) y desde "Reimprimir" en Historial de Ventas.
 *
 * Patrón canónico (DripBurger/Sinatra/StockFlow): `window.print()` con
 * #print-area + @media print — el ÚNICO camino que imprime confiable en las
 * térmicas del cliente. Si el usuario configuró impresión directa, el main
 * activó `--kiosk-printing` y `window.print()` sale SIN diálogo a la impresora
 * predeterminada; si no, muestra el diálogo del SO. (Se descartaron
 * webContents.print silent —#39092— y SumatraPDF —corría sin sacar papel.)
 */
import { createElement } from 'react'
import { toast } from 'sonner'

import { SaleTicket, type SaleTicketData } from '@/print/SaleTicket'
import { printNode, widthFromPaperFormat } from '@/lib/printService'
import type { PrinterConfigDTO } from '@/types/api'

export async function printSaleTicketSilent(
  ticketData: SaleTicketData,
  printerCfg: PrinterConfigDTO | null,
): Promise<void> {
  const ticketWidth = widthFromPaperFormat(printerCfg?.paperFormat) === '80' ? '80' : '58'
  try {
    await printNode(createElement(SaleTicket, { data: ticketData }), ticketWidth)
  } catch (err) {
    toast.error(
      err instanceof Error ? `No se pudo imprimir: ${err.message}` : 'No se pudo imprimir el ticket',
    )
  }
}
