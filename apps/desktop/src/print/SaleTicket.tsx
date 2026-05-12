/**
 * Ticket de venta estilo impresora térmica de 80mm (ancho fijo, monoespaciado).
 * Recibe los datos ya ensamblados (las líneas necesitan la descripción del
 * artículo, que el `SaleLineDTO` no trae).
 */
import type { CompanyDTO, SaleDTO, VoucherType } from '@/types/api'
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

export interface SaleTicketData {
  company: CompanyDTO
  sale: SaleDTO
  lines: SaleTicketLine[]
  /** Nombre del cliente; `null` para Consumidor Final (no se imprime). */
  customerName: string | null
  /** Documento del cliente ("DNI 12345678"); `null` si no aplica. */
  customerDoc: string | null
  /** "Efectivo" / "Tarjeta" / "Mixto" / "Cuenta corriente". */
  paymentLabel: string
  cardName: string | null
  /** Sólo en pagos en efectivo. */
  received: number | null
  change: number | null
}

function Hr() {
  return <div className="my-1 border-t border-dashed border-black" />
}

export function SaleTicket({ data }: { data: SaleTicketData }) {
  const { company, sale, lines, customerName, customerDoc, paymentLabel, cardName, received, change } = data
  const cardAmount = sale.cardAmount ? Number(sale.cardAmount) : 0
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
      <div className="flex justify-between">
        <span>Subtotal</span>
        <span>{formatCurrency(sale.subtotal)}</span>
      </div>
      {Number(sale.discount) > 0 && (
        <div className="flex justify-between">
          <span>Descuento</span>
          <span>-{formatCurrency(sale.discount)}</span>
        </div>
      )}
      <div className="flex justify-between text-[10px]">
        <span>IVA contenido</span>
        <span>{formatCurrency(sale.vatAmount)}</span>
      </div>
      <div className="mt-0.5 flex justify-between text-sm font-bold">
        <span>TOTAL</span>
        <span>{formatCurrency(sale.total)}</span>
      </div>
      <Hr />
      <div>
        Forma de pago: {paymentLabel}
        {cardName ? ` (${cardName})` : ''}
      </div>
      {cardAmount > 0 && (
        <div className="flex justify-between">
          <span>En tarjeta</span>
          <span>{formatCurrency(cardAmount)}</span>
        </div>
      )}
      {received != null && (
        <div className="flex justify-between">
          <span>Recibido</span>
          <span>{formatCurrency(received)}</span>
        </div>
      )}
      {change != null && change > 0 && (
        <div className="flex justify-between">
          <span>Vuelto</span>
          <span>{formatCurrency(change)}</span>
        </div>
      )}
      <Hr />
      <div className="mt-1 text-center">¡Gracias por su compra!</div>
      <div className="text-center text-[10px]">Documento no válido como comprobante fiscal</div>
    </div>
  )
}
