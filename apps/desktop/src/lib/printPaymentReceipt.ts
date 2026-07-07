/**
 * Impresión del recibo de una cobranza de cuenta corriente.
 *
 * Mismo criterio que `printSaleTicket`: si hay una térmica del sistema en modo
 * directo (silencioso), se manda ESC/POS CRUDO al spooler
 * (`api.hardware.printer.printPaymentReceipt`). Si el usuario eligió diálogo, no
 * es térmica del sistema, es A4, o el ESC/POS falla → `printNode` (window.print).
 */
import { createElement } from 'react'
import { toast } from 'sonner'

import { PaymentReceipt, type PaymentReceiptData } from '@/print/PaymentReceipt'
import { printNode } from '@/lib/printService'
import { api } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'
import type { PaymentReceiptDataDTO, PrinterConfigDTO } from '@/types/api'

/** Mapea los datos del recibo (renderer) al DTO que consume el motor ESC/POS. */
export function toEscPosReceiptDTO(data: PaymentReceiptData): PaymentReceiptDataDTO {
  return {
    company: {
      name: data.company.name,
      cuit: data.company.cuit,
      address: data.company.address,
      phone: data.company.phone,
      ingBrutos: data.company.ingBrutos,
    },
    customer: { name: data.customerName, docNumber: data.customerDoc },
    createdAt: data.date,
    paymentMethod: data.paymentMethod,
    amount: data.amount,
    comprobanteRef: data.comprobanteRef,
    comprobanteBalance: data.comprobanteBalance,
    accountBalance: data.accountBalance,
    title: data.title,
    partyLabel: data.partyLabel,
    // El período viaja pre-formateado: el motor ESC/POS sólo imprime líneas.
    period: data.period
      ? {
          title: `DETALLE ${formatDate(data.period.from)} AL ${formatDate(data.period.to)}`,
          lines: data.period.lines.map((l) => ({
            label: `${formatDate(l.date)} ${l.label}`,
            amount: formatCurrency(l.amount),
          })),
          totals: [
            { label: 'Total periodo', amount: formatCurrency(data.period.charges) },
            ...(Number(data.period.payments) > 0.005
              ? [{ label: 'Pagos del periodo', amount: `-${formatCurrency(data.period.payments)}` }]
              : []),
          ],
        }
      : undefined,
  }
}

export async function printPaymentReceiptSilent(
  data: PaymentReceiptData,
  printerCfg: PrinterConfigDTO | null,
): Promise<void> {
  // El recibo se imprime siempre como ticket angosto (no A4 formal). Para A4
  // usamos 58mm por defecto.
  const width = printerCfg?.paperFormat === '80mm' ? '80' : '58'
  const useDialog = printerCfg?.silentPrint === false
  const printViaDialog = (): Promise<void> =>
    printNode(createElement(PaymentReceipt, { data }), width)
  try {
    if (!useDialog && printerCfg?.kind === 'system' && printerCfg.paperFormat !== 'A4') {
      try {
        await api.hardware.printer.printPaymentReceipt(toEscPosReceiptDTO(data))
        return
      } catch (escErr) {
        console.warn('Impresión ESC/POS del recibo falló, uso diálogo del SO:', escErr)
      }
    }
    await printViaDialog()
  } catch (err) {
    toast.error(
      err instanceof Error ? `No se pudo imprimir: ${err.message}` : 'No se pudo imprimir el recibo',
    )
  }
}
