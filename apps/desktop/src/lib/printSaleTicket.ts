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

/**
 * Numeración y letra IMPRESAS: con CAE mandan las del comprobante autorizado
 * (PPPPP-NNNNNNNN y su letra), no las internas de la venta. En una base
 * migrada ARCA autorizaba 00004-00000001 y el papel decía "N° 00008015".
 * (Misma regla que en `SaleTicket`, que no puede exportarla por el fast refresh.)
 */
function ticketNumber(data: Pick<SaleTicketData, 'sale' | 'fiscal'>): string {
  const f = data.fiscal
  if (f?.cae && f.salePoint != null && f.number != null) {
    return `${String(f.salePoint).padStart(5, '0')}-${String(f.number).padStart(8, '0')}`
  }
  return String(data.sale.number).padStart(8, '0')
}
function ticketVoucherType(data: Pick<SaleTicketData, 'sale' | 'fiscal'>): VoucherType {
  return data.fiscal?.cae && data.fiscal.letter ? data.fiscal.letter : data.sale.type
}

/** Mapea el ticket de venta al documento formal A4 (cuando el formato es A4). */
function toFormalDocFromSale(data: SaleTicketData): FormalDocData {
  const meta: FormalDocData['meta'] = [{ label: 'Fecha', value: formatDateTime(data.sale.date) }]
  if (data.sellerName) meta.push({ label: 'Vendedor', value: data.sellerName })
  const single = data.payments.length === 1 ? data.payments[0]!.methodName : null
  // Con CAE manda la letra del comprobante autorizado (puede no ser la de la
  // venta si se facturó después desde el Historial).
  const tipo = ticketVoucherType(data)
  const esFacturaA = tipo === 'A'

  // DETALLE DE ALÍCUOTAS: se arma agrupando los renglones por tasa. Sólo en la
  // Factura A, que es donde el IVA se discrimina. El neto de cada renglón sale
  // de sacarle el impuesto al importe cuando los precios se cargan CON IVA
  // (`priceMode: 'gross'`, que es como trabaja el comercio); si se cargan netos,
  // el importe YA es el neto. El descuento global se prorratea sobre los
  // renglones (misma regla que la venta y que el CAE): con $1210 y $110 de
  // descuento el papel decía base 1000 / IVA 210 y ARCA autorizó 909,09 / 190,91.
  const subtotalNum = Number(data.sale.subtotal)
  const factorDescuento = subtotalNum > 0 ? 1 - Number(data.sale.discount) / subtotalNum : 1
  const vatBreakdown = esFacturaA
    ? [
        ...data.lines
          .reduce((acc, l) => {
            const rate = Number(l.vatRate ?? 0)
            if (!Number.isFinite(rate)) return acc
            const importe = Number(l.lineTotal) * factorDescuento
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
      tipo !== 'X' && !data.fiscal?.cae
        ? `${VOUCHER_LABELS[tipo].toUpperCase()} — SIN AUTORIZAR (documento no válido)`
        : VOUCHER_LABELS[tipo].toUpperCase(),
    // Con CAE va la numeración de ARCA (PPPPP-NNNNNNNN); el número interno de
    // la venta no es el del comprobante.
    number: ticketNumber(data),
    meta,
    // Con nombre O documento: en la Factura A de mostrador (ficha Consumidor
    // Final + CUIT tipeado) no hay nombre pero el CUIT y la condición que se le
    // informaron a ARCA tienen que salir en el papel, que es lo que el receptor
    // usa para el crédito fiscal. Mirando sólo el nombre salía "Consumidor
    // Final / Consumidor Final" sin el CUIT.
    customer:
      data.customerName || data.customerDoc
        ? {
            name: data.customerName ?? 'Consumidor Final',
            doc: data.customerDoc,
            vatCondition: data.customerVatCondition,
          }
        : null,
    // ORIGINAL sólo en comprobantes fiscales: en un remito X no significa nada.
    // Se mira la letra IMPRESA (`tipo`), no la de la venta: una venta X
    // facturada después desde el Historial salía titulada FACTURA sin esto.
    copyLabel: tipo !== 'X' ? 'Original' : null,
    saleCondition: data.isAccountSale ? 'Cuenta corriente' : (single ?? 'Contado'),
    vatBreakdown,
    lines: data.lines,
    totals: {
      subtotal: data.sale.subtotal,
      discount: data.sale.discount,
      vatAmount: data.sale.vatAmount,
      vatLabel: data.priceMode === 'gross' && !esFacturaA ? 'IVA (incluido)' : 'IVA',
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
      tipo !== 'X'
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
    voucherType: ticketVoucherType(data),
    createdAt: data.sale.date,
    company: {
      name: data.company.name,
      cuit: data.company.cuit,
      address: data.company.address,
      phone: data.company.phone,
      ingBrutos: data.company.ingBrutos,
    },
    // Consumidor final con documento tipeado en el mostrador: el documento y la
    // condición informados a ARCA van al ticket igual que en el A4. Sin nombre
    // se manda vacío y la térmica omite la línea "Cliente": en la Factura A de
    // mostrador "Cliente: Consumidor Final" contradecía la condición IVA
    // (Responsable Inscripto) impresa debajo.
    customer:
      data.customerName || data.customerDoc
        ? {
            name: data.customerName ?? '',
            docNumber: data.customerDoc,
            vatCondition: data.customerVatCondition ?? null,
          }
        : null,
    vatIncluded: data.priceMode === 'gross',
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
    fiscalSalePoint: data.fiscal?.salePoint ?? null,
    fiscalNumber: data.fiscal?.number ?? null,
    fiscalQrUrl: data.fiscal?.qrUrl ?? null,
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
