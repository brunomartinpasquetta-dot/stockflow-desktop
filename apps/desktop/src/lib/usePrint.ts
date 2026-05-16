/**
 * Hooks de impresión: devuelven un callback que monta la vista correspondiente
 * en `#print-area` (ver `printService.ts`) y dispara `window.print()`.
 *
 * Cada hook lee la config de impresora para decidir el ancho lógico
 * (58/80/A4). Si no hay config, default 58mm para tickets y A4 para reportes.
 */
import { createElement, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { printNode, widthFromPaperFormat, type PrintOptions, type PrintWidth } from '@/lib/printService'
import { CashCloseReport, type CashCloseReportData } from '@/print/CashCloseReport'
import { HistoricalCashReport, type HistoricalCashReportData } from '@/print/HistoricalCashReport'
import { SaleTicket, type SaleTicketData } from '@/print/SaleTicket'
import { AccountingSummaryReport, type AccountingSummaryReportData } from '@/print/AccountingSummaryReport'
import { VatBookReport, type VatBookReportData } from '@/print/VatBookReport'

/**
 * Devuelve la config de impresora (ancho lógico + opciones de impresión
 * silenciosa). El hook lee la config persistida; si todavía no cargó, devuelve
 * defaults seguros (58mm, con dialog).
 */
function usePrintConfig(): { width: PrintWidth; opts: PrintOptions } {
  const cfgQuery = useQuery({
    queryKey: ['hardware', 'printer', 'config'],
    queryFn: () => api.hardware.printer.getConfig(),
    staleTime: 30_000,
  })
  const cfg = cfgQuery.data
  const width = widthFromPaperFormat(cfg?.paperFormat)
  // Impresión silenciosa: requiere kind:'system' (que el `interface` sea el
  // nombre de impresora del SO) + flag activo + papel térmico (58/80).
  const canSilent =
    !!cfg && cfg.kind === 'system' && cfg.silentPrint === true && (width === '58' || width === '80')
  const opts: PrintOptions = {
    width,
    silent: canSilent,
    deviceName: canSilent ? cfg.interface : undefined,
  }
  return { width, opts }
}

export function usePrintSaleTicket() {
  const { opts } = usePrintConfig()
  return useCallback(
    (data: SaleTicketData) => printNode(createElement(SaleTicket, { data }), opts),
    [opts],
  )
}

export function usePrintCashClose() {
  const { opts } = usePrintConfig()
  // Los reportes de cierre son extensos: si la impresora es térmica
  // (58/80) igualmente se imprime, pero por defecto preferimos A4 si está
  // configurado. Respeta el ancho elegido por el usuario.
  return useCallback(
    (data: CashCloseReportData) => printNode(createElement(CashCloseReport, { data }), opts),
    [opts],
  )
}

/** Alias para que el código nuevo de historial use un nombre consistente. */
export const usePrintCashCloseReport = usePrintCashClose

export function usePrintHistoricalCashReport() {
  const { opts } = usePrintConfig()
  return useCallback(
    (data: HistoricalCashReportData) =>
      printNode(createElement(HistoricalCashReport, { data }), opts),
    [opts],
  )
}

export function usePrintAccountingSummary() {
  // Reporte de oficina — siempre A4.
  return useCallback(
    (data: AccountingSummaryReportData) =>
      printNode(createElement(AccountingSummaryReport, { data }), 'a4'),
    [],
  )
}

export function usePrintVatBook() {
  // Libro IVA — siempre A4.
  return useCallback(
    (data: VatBookReportData) => printNode(createElement(VatBookReport, { data }), 'a4'),
    [],
  )
}
