/**
 * Ticket de venta — diseño profesional no fiscal.
 *
 * Usa las clases `ticket-*` definidas en `index.css` (@media print) y el CSS
 * inline de `printService.ts` para la impresión silenciosa. El contenido
 * ocupa SIEMPRE el ancho completo del rollo (58mm / 80mm): el `<div>` raíz
 * lleva `ticket-root` (width:100%) y NO define ningún `max-width`.
 *
 * Se imprime vía `printNode` (window.print() + driver del SO) o vía silent
 * print. Funciona en 58mm y 80mm.
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
  const isFiscal = sale.type === 'A' || sale.type === 'B' || sale.type === 'C'

  return (
    <div className="ticket-root">
      {/* ── Encabezado del comercio ─────────────────────────── */}
      <div className="ticket-double">{company.name}</div>
      {company.address && <div className="ticket-center ticket-small">{company.address}</div>}
      {company.phone && <div className="ticket-center ticket-small">Tel: {company.phone}</div>}
      {company.cuit && <div className="ticket-center ticket-small">CUIT: {company.cuit}</div>}

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Datos del comprobante ───────────────────────────── */}
      <div className="ticket-bold ticket-center">
        {isFiscal ? 'COMPROBANTE NO FISCAL' : VOUCHER_LABELS[sale.type]}
      </div>
      <div className="ticket-bold">
        {VOUCHER_LABELS[sale.type]} N° {String(sale.number).padStart(8, '0')}
      </div>
      <div>{formatDateTime(sale.date)}</div>
      <div>Cliente: {customerName ?? 'Consumidor Final'}</div>
      {customerDoc && <div>{customerDoc}</div>}

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Items ───────────────────────────────────────────── */}
      <div className="ticket-bold">CANT  DESCRIPCIÓN</div>
      <div className="ticket-bold ticket-row">
        <span>P.UNIT</span>
        <span>SUBTOTAL</span>
      </div>
      <div className="ticket-sep">{SEP_DASH}</div>

      {lines.map((l, i) => (
        <div key={i} className="ticket-item">
          <div>
            {formatNumber(l.quantity, 3)}  {l.description}
          </div>
          <div className="ticket-row ticket-indent">
            <span>{formatCurrency(l.unitPrice)}</span>
            <span>{formatCurrency(l.lineTotal)}</span>
          </div>
        </div>
      ))}

      <div className="ticket-sep">{SEP_DASH}</div>

      {/* ── Totales ─────────────────────────────────────────── */}
      {discriminateVat ? (
        <>
          <div className="ticket-row">
            <span>Subtotal neto:</span>
            <span>{formatCurrency(netSubtotal.toFixed(4))}</span>
          </div>
          {discountNum > 0 && (
            <div className="ticket-row">
              <span>Descuento:</span>
              <span>-{formatCurrency(sale.discount)}</span>
            </div>
          )}
          <div className="ticket-row">
            <span>IVA:</span>
            <span>{formatCurrency(sale.vatAmount)}</span>
          </div>
        </>
      ) : (
        <>
          <div className="ticket-row">
            <span>Subtotal:</span>
            <span>{formatCurrency(sale.subtotal)}</span>
          </div>
          {discountNum > 0 && (
            <div className="ticket-row">
              <span>Descuento:</span>
              <span>-{formatCurrency(sale.discount)}</span>
            </div>
          )}
          <div className="ticket-row">
            <span>IVA:</span>
            <span>{vatNum > 0 ? `(incluido) ${formatCurrency(sale.vatAmount)}` : '(incluido)'}</span>
          </div>
        </>
      )}

      <div className="ticket-sep">{SEP_EQ}</div>

      <div className="ticket-row ticket-total">
        <span>TOTAL:</span>
        <span>{formatCurrency(sale.total)}</span>
      </div>

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Forma de pago ───────────────────────────────────── */}
      {isAccountSale ? (
        <div className="ticket-bold">Forma de pago: CUENTA CORRIENTE</div>
      ) : (
        <>
          <div className="ticket-bold">Forma de pago:</div>
          {payments.map((p, i) => (
            <div key={i} className="ticket-row ticket-indent">
              <span>{p.methodName}</span>
              <span>{formatCurrency(p.amount)}</span>
            </div>
          ))}
        </>
      )}

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Pie ─────────────────────────────────────────────── */}
      <div className="ticket-center ticket-bold">¡Gracias por su compra!</div>
      <div className="ticket-center ticket-small">Documento no válido como</div>
      <div className="ticket-center ticket-small">comprobante fiscal</div>

      <div className="ticket-spacer" />
    </div>
  )
}
