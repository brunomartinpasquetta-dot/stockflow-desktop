/**
 * Hooks de impresión: devuelven un callback que monta la vista correspondiente
 * en el contenedor de impresión (ver `PrintProvider`) y abre el diálogo.
 */
import { createElement, useCallback } from 'react'

import { usePrint } from '@/contexts/PrintContext'
import { CashCloseReport, type CashCloseReportData } from '@/print/CashCloseReport'
import { SaleTicket, type SaleTicketData } from '@/print/SaleTicket'

export function usePrintSaleTicket() {
  const { print } = usePrint()
  return useCallback((data: SaleTicketData) => print(createElement(SaleTicket, { data })), [print])
}

export function usePrintCashClose() {
  const { print } = usePrint()
  return useCallback((data: CashCloseReportData) => print(createElement(CashCloseReport, { data })), [print])
}
