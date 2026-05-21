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
  // Lista de impresoras del SO vía Electron (devuelve el deviceName EXACTO).
  const printersQuery = useQuery({
    queryKey: ['print', 'electron-printers'],
    queryFn: () => api.print.listElectron(),
    staleTime: 30_000,
  })
  const cfg = cfgQuery.data
  const width = widthFromPaperFormat(cfg?.paperFormat)

  // deviceName: 1) el configurado si existe y kind='system'; 2) la impresora
  // por defecto del SO; 3) la primera impresora disponible.
  const printers = printersQuery.data ?? []
  const configuredName =
    cfg && cfg.kind === 'system' && typeof cfg.interface === 'string' && cfg.interface.trim() !== ''
      ? cfg.interface.trim()
      : null
  const defaultPrinter = printers.find((p) => p.isDefault)?.name ?? printers[0]?.name ?? null
  const deviceName = configuredName ?? defaultPrinter ?? undefined

  // Override: si el usuario forzó el diálogo explícitamente.
  const forceDialog = !!cfg && cfg.silentPrint === false
  // Silencioso si hay deviceName y el papel es térmico (58/80).
  const canSilent = !!deviceName && !forceDialog && (width === '58' || width === '80')

  const opts: PrintOptions = {
    width,
    silent: canSilent,
    deviceName: canSilent ? deviceName : undefined,
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
