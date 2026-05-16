/**
 * Ticket de venta — usa las clases `ticket-*` definidas en `index.css`
 * (@media print). Se imprime vía `printNode` (window.print() + driver
 * del SO). Funciona en 58mm, 80mm y A4.
 */
import type { CompanyDTO, PriceMode, SaleDTO, VoucherType } from '@/types/api'
import { formatCurrency, formatDateTime, formatNumber } from '@/lib/format'

const VOUCHER_LABELS: Record<VoucherType, string> = {
  A: 'FACTURA A',
  B: 'FACTURA B',
  C: 'FACTURA C',
  X: 'COMPROBANTE X',
}

// Ancho lógico del ticket en caracteres (para los separadores). 32 funciona
// bien para 58mm y se ve correcto en 80mm también con la tipografía actual.
const WIDTH = 32
const SEP_EQ = '='.repeat(WIDTH)
const SEP_DASH = '-'.repeat(WIDTH)

export interface SaleTicketLine {
  description: string
  quantity: string
  unitPrice: string
  lineTotal: string
}

export interface SaleTicketPayment {
  methodName: string
  amount: string
}

export interface SaleTicketData {
  company: CompanyDTO
  sale: SaleDTO
  /** Modo de precios vigente al emitir el comprobante. */
  priceMode: PriceMode
  lines: SaleTicketLine[]
  /** Nombre del cliente; `null` para Consumidor Final (no se imprime). */
  customerName: string | null
  /** Documento del cliente ("DNI 12345678"); `null` si no aplica. */
  customerDoc: string | null
  isAccountSale: boolean
  /** Desglose de pagos (vacío si es venta a cuenta corriente). La suma es igual al total. */
  payments: SaleTicketPayment[]
}

export function SaleTicket({ data }: { data: SaleTicketData }) {
  const { company, sale, priceMode, lines, customerName, customerDoc, isAccountSale, payments } = data
  const discountNum = Number(sale.discount)
  const vatNum = Number(sale.vatAmount)
  const subtotalNum = Number(sale.subtotal)
  // En 'gross' el subtotal incluye IVA → el neto es subtotal − IVA. En 'net' el subtotal ya es neto.
  const netSubtotal = priceMode === 'gross' ? subtotalNum - vatNum : subtotalNum
  // Los comprobantes A discriminan IVA siempre (obligatorio fiscalmente).
  const discriminateVat = sale.type === 'A' || priceMode === 'net'

  return (
    <div>
      <div className="ticket-center ticket-double-height">{company.name}</div>
      {company.address && <div className="ticket-center">{company.address}</div>}
      {company.phone && <div className="ticket-center">Tel: {company.phone}</div>}
      {company.cuit && <div className="ticket-center">CUIT: {company.cuit}</div>}

      <div className="ticket-sep">{SEP_EQ}</div>

      <div className="ticket-bold">
        {VOUCHER_LABELS[sale.type]} N° {String(sale.number).padStart(8, '0')}
      </div>
      <div>Fecha: {formatDateTime(sale.date)}</div>
      {customerName && <div>Cliente: {customerName}</div>}
      {customerDoc && <div>{customerDoc}</div>}

      <div className="ticket-sep">{SEP_EQ}</div>

      {lines.map((l, i) => (
        <div key={i}>
          <div className="ticket-bold">{l.description}</div>
          <div className="ticket-row">
            <span>
              {formatNumber(l.quantity, 3)} x {formatCurrency(l.unitPrice)}
            </span>
            <span>{formatCurrency(l.lineTotal)}</span>
          </div>
        </div>
      ))}

      <div className="ticket-sep">{SEP_DASH}</div>

      {discriminateVat ? (
        <>
          <div className="ticket-row">
            <span>Subtotal neto</span>
            <span>{formatCurrency(netSubtotal.toFixed(4))}</span>
          </div>
          {discountNum > 0 && (
            <div className="ticket-row">
              <span>Descuento</span>
              <span>-{formatCurrency(sale.discount)}</span>
            </div>
          )}
          <div className="ticket-row">
            <span>IVA</span>
            <span>{formatCurrency(sale.vatAmount)}</span>
          </div>
        </>
      ) : (
        <>
          <div className="ticket-row">
            <span>Subtotal</span>
            <span>{formatCurrency(sale.subtotal)}</span>
          </div>
          {discountNum > 0 && (
            <div className="ticket-row">
              <span>Descuento</span>
              <span>-{formatCurrency(sale.discount)}</span>
            </div>
          )}
          {vatNum > 0 && (
            <div className="ticket-row">
              <span>(Incluye IVA</span>
              <span>{formatCurrency(sale.vatAmount)})</span>
            </div>
          )}
        </>
      )}

      <div className="ticket-sep">{SEP_DASH}</div>

      <div className="ticket-row ticket-double-height">
        <span>TOTAL</span>
        <span>{formatCurrency(sale.total)}</span>
      </div>

      <div className="ticket-sep">{SEP_DASH}</div>

      {isAccountSale ? (
        <div className="ticket-bold">Forma de pago: CUENTA CORRIENTE</div>
      ) : (
        <>
          <div>Forma de pago:</div>
          {payments.map((p, i) => (
            <div key={i} className="ticket-row">
              <span>{p.methodName}</span>
              <span>{formatCurrency(p.amount)}</span>
            </div>
          ))}
        </>
      )}

      <div className="ticket-sep">{SEP_EQ}</div>

      <div className="ticket-center">¡Gracias por su compra!</div>
      <div className="ticket-center">Documento no válido como comprobante fiscal</div>

      <div className="ticket-spacer" />
    </div>
  )
}
