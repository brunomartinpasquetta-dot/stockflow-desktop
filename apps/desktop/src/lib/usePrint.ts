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
import { FormalDocA4, type FormalDocData } from '@/print/FormalDocA4'
import { HistoricalCashReport, type HistoricalCashReportData } from '@/print/HistoricalCashReport'
import { SaleTicket, type SaleTicketData } from '@/print/SaleTicket'
import { AccountingSummaryReport, type AccountingSummaryReportData } from '@/print/AccountingSummaryReport'
import { VatBookReport, type VatBookReportData } from '@/print/VatBookReport'

/**
 * Devuelve la config de impresora (ancho lógico + opciones de impresión
 * silenciosa). El hook lee la config persistida; si todavía no cargó, devuelve
 * defaults seguros (58mm).
 *
 * Impresión directa (v0.1.19): el modo silencioso es el camino POR DEFECTO
 * para tickets térmicos (58/80). El `deviceName` se resuelve SIEMPRE, aunque
 * el usuario nunca haya tocado Configuración:
 *   1) la impresora configurada (`kind:'system'` con `interface` válido), si existe
 *   2) la impresora por defecto del SO (`getPrintersAsync` → `isDefault`)
 *   3) la primera impresora disponible
 * Así el ticket se imprime directo y completo sin diálogo. El flag
 * `silentPrint === false` queda como override explícito para forzar el diálogo.
 * Si el silent print falla, `printNode` ya hace fallback automático al diálogo.
 */
function usePrintConfig(): { width: PrintWidth; opts: PrintOptions } {
  const cfgQuery = useQuery({
    queryKey: ['hardware', 'printer', 'config'],
    queryFn: () => api.hardware.printer.getConfig(),
    staleTime: 30_000,
  })
  const width = widthFromPaperFormat(cfgQuery.data?.paperFormat)
  return { width, opts: { width } }
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

export function usePrintQuote() {
  // Presupuesto — documento formal A4.
  return useCallback(
    (data: FormalDocData) => printNode(createElement(FormalDocA4, { data }), 'a4'),
    [],
  )
}
