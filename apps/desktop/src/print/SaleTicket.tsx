/**
 * Ticket de venta estilo impresora térmica de 80mm (ancho fijo, monoespaciado).
 * Recibe los datos ya ensamblados (las líneas necesitan la descripción del
 * artículo y los pagos el nombre del medio, que los DTOs crudos no traen).
 */
import type { CompanyDTO, PriceMode, SaleDTO, VoucherType } from '@/types/api'
import { formatCurrency, formatDateTime, formatNumber } from '@/lib/format'

const VOUCHER_LABELS: Record<VoucherType, string> = {
  A: 'FACTURA A',
  B: 'FACTURA B',
  C: 'FACTURA C',
  X: 'COMPROBANTE X',
}

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
  /** Desglose de pagos (vacío si es venta a cuenta corriente). */
  payments: SaleTicketPayment[]
  /** Total efectivamente entregado por el cliente (suma de pagos + vuelto). */
  received: number | null
  /** Vuelto entregado (informativo). */
  change: number | null
}

function Hr() {
  return <div className="my-1 border-t border-dashed border-black" />
}

export function SaleTicket({ data }: { data: SaleTicketData }) {
  const { company, sale, priceMode, lines, customerName, customerDoc, isAccountSale, payments, received, change } = data
  const discountNum = Number(sale.discount)
  const vatNum = Number(sale.vatAmount)
  const subtotalNum = Number(sale.subtotal)
  // En 'gross' el subtotal incluye IVA → el neto es subtotal − IVA. En 'net' el subtotal ya es neto.
  const netSubtotal = priceMode === 'gross' ? subtotalNum - vatNum : subtotalNum
  // Los comprobantes A discriminan IVA siempre (obligatorio fiscalmente).
  const discriminateVat = sale.type === 'A' || priceMode === 'net'
  return (
    <div className="print-ticket">
      <div className="text-center">
        <div className="text-sm font-bold uppercase">{company.name}</div>
        {company.address && <div>{company.address}</div>}
        {company.phone && <div>Tel: {company.phone}</div>}
        {company.cuit && <div>CUIT: {company.cuit}</div>}
      </div>
      <Hr />
      <div className="font-bold">
        {VOUCHER_LABELS[sale.type]} N° {String(sale.number).padStart(8, '0')}
      </div>
      <div>Fecha: {formatDateTime(sale.date)}</div>
      {customerName && <div>Cliente: {customerName}</div>}
      {customerDoc && <div>{customerDoc}</div>}
      <Hr />
      {lines.map((l, i) => (
        <div key={i} className="mt-0.5">
          <div>{l.description}</div>
          <div className="flex justify-between">
            <span>
              {formatNumber(l.quantity, 3)} x {formatCurrency(l.unitPrice)}
            </span>
            <span>{formatCurrency(l.lineTotal)}</span>
          </div>
        </div>
      ))}
      <Hr />
      {discriminateVat ? (
        <>
          <div className="flex justify-between">
            <span>Subtotal neto</span>
            <span>{formatCurrency(netSubtotal.toFixed(4))}</span>
          </div>
          {discountNum > 0 && (
            <div className="flex justify-between">
              <span>Descuento</span>
              <span>-{formatCurrency(sale.discount)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>IVA</span>
            <span>{formatCurrency(sale.vatAmount)}</span>
          </div>
        </>
      ) : (
        <>
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCurrency(sale.subtotal)}</span>
          </div>
          {discountNum > 0 && (
            <div className="flex justify-between">
              <span>Descuento</span>
              <span>-{formatCurrency(sale.discount)}</span>
            </div>
          )}
          {vatNum > 0 && (
            <div className="flex justify-between text-[10px]">
              <span>(Incluye IVA</span>
              <span>{formatCurrency(sale.vatAmount)})</span>
            </div>
          )}
        </>
      )}
      <div className="mt-0.5 flex justify-between text-sm font-bold">
        <span>TOTAL</span>
        <span>{formatCurrency(sale.total)}</span>
      </div>
      <Hr />
      {isAccountSale ? (
        <div className="font-bold">Forma de pago: CUENTA CORRIENTE</div>
      ) : (
        <>
          <div>Forma de pago:</div>
          {payments.map((p, i) => (
            <div key={i} className="flex justify-between">
              <span>{p.methodName}</span>
              <span>{formatCurrency(p.amount)}</span>
            </div>
          ))}
          {received != null && (
            <div className="flex justify-between">
              <span>Total pagado</span>
              <span>{formatCurrency(received)}</span>
            </div>
          )}
          {change != null && change > 0 && (
            <div className="flex justify-between">
              <span>Vuelto</span>
              <span>{formatCurrency(change)}</span>
            </div>
          )}
        </>
      )}
      <Hr />
      <div className="mt-1 text-center">¡Gracias por su compra!</div>
      <div className="text-center text-[10px]">Documento no válido como comprobante fiscal</div>
    </div>
  )
}
