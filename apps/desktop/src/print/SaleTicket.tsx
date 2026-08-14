/**
 * Ticket de venta — diseño tipo ticket comercial real.
 *
 * Usa las clases `ticket-*` definidas en `index.css` (@media print). El
 * contenido ocupa SIEMPRE el ancho completo del rollo (58mm / 80mm): el
 * `<div>` raíz lleva `ticket-root` (width:100%) y NO define ningún `max-width`.
 *
 * Se imprime vía `printNode` (window.print() + driver del SO). Funciona en
 * 58mm y 80mm.
 */
import type { CompanyDTO, PriceMode, SaleDTO, VoucherType } from '@/types/api'
import { formatCurrency, formatDateTime, formatQty } from '@/lib/format'

const VOUCHER_LABELS: Record<VoucherType, string> = {
  A: 'Factura A',
  B: 'Factura B',
  C: 'Factura C',
  X: 'Remito X',
}

// Ancho lógico del ticket en caracteres (para los separadores).
const WIDTH = 32
const SEP_EQ = '='.repeat(WIDTH)
const SEP_DASH = '-'.repeat(WIDTH)

/**
 * Formatea la cantidad: entera sin decimales (`2`), o con hasta 3 decimales
 * sin ceros sobrantes para artículos por peso (`0,75`).
 */
function formatQuantity(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return formatQty(n)
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
  /** Nombre del vendedor que registró la venta; `null` si no se conoce. */
  sellerName: string | null
  isAccountSale: boolean
  /** Desglose de pagos (vacío si es venta a cuenta corriente). */
  payments: SaleTicketPayment[]
  /**
   * Comprobante autorizado por ARCA. Va en el ticket Y en el A4: un comprobante
   * fiscal SIN el CAE y el QR no es válido, y hasta ahora no se imprimían en
   * ninguno de los dos formatos.
   */
  fiscal?: {
    cae: string
    caeExpiry?: number | null
    qrDataUrl?: string | null
    letter?: 'A' | 'B' | 'C'
  } | null
}

export function SaleTicket({ data }: { data: SaleTicketData }) {
  const { company, sale, priceMode, lines, customerName, customerDoc, sellerName, isAccountSale, payments, fiscal } = data
  const discountNum = Number(sale.discount)
  const vatNum = Number(sale.vatAmount)

  return (
    <div className="ticket-root">
      {/* ── Datos del negocio ───────────────────────────────── */}
      <div className="ticket-double">{company.name}</div>
      {company.address && <div className="ticket-center ticket-small">{company.address}</div>}
      {company.phone && <div className="ticket-center ticket-small">Tel: {company.phone}</div>}
      {company.cuit && <div className="ticket-center ticket-small">CUIT: {company.cuit}</div>}

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Datos del comprobante ───────────────────────────── */}
      <div className="ticket-row">
        <span className="ticket-bold">{VOUCHER_LABELS[sale.type]}</span>
        <span className="ticket-bold">N° {String(sale.number).padStart(8, '0')}</span>
      </div>
      <div>Fecha: {formatDateTime(sale.date)}</div>
      {sellerName && <div>Vendedor: {sellerName}</div>}
      <div>Cliente: {customerName ?? 'Consumidor Final'}</div>
      {customerDoc && <div>{customerDoc}</div>}

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Detalle de artículos ────────────────────────────── */}
      {/* Por cada ítem: descripción / cantidad x precio unitario / total. */}
      <div className="ticket-row ticket-bold">
        <span>Artículo</span>
        <span>Importe</span>
      </div>
      <div className="ticket-sep">{SEP_DASH}</div>

      {lines.map((l, i) => (
        <div key={i} className="ticket-item">
          <div className="ticket-bold">{l.description}</div>
          <div className="ticket-row">
            <span>
              {formatQuantity(l.quantity)} x {formatCurrency(l.unitPrice)}
            </span>
            <span>{formatCurrency(l.lineTotal)}</span>
          </div>
        </div>
      ))}

      <div className="ticket-sep">{SEP_DASH}</div>

      {/* ── Totales ─────────────────────────────────────────── */}
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
      {vatNum > 0 && (
        <div className="ticket-row">
          <span>IVA{priceMode === 'gross' && sale.type !== 'A' ? ' (incluido)' : ''}:</span>
          <span>{formatCurrency(sale.vatAmount)}</span>
        </div>
      )}

      <div className="ticket-sep">{SEP_EQ}</div>

      <div className="ticket-row ticket-total">
        <span>TOTAL</span>
        <span>{formatCurrency(sale.total)}</span>
      </div>

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Forma de pago ───────────────────────────────────── */}
      {isAccountSale ? (
        <div className="ticket-bold">Forma de pago: Cuenta corriente</div>
      ) : payments.length === 1 ? (
        <div className="ticket-bold">Forma de pago: {payments[0]!.methodName}</div>
      ) : payments.length > 1 ? (
        <>
          <div className="ticket-bold">Forma de pago:</div>
          {payments.map((p, i) => (
            <div key={i} className="ticket-row ticket-indent">
              <span>{p.methodName}</span>
              <span>{formatCurrency(p.amount)}</span>
            </div>
          ))}
        </>
      ) : null}

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Pie fiscal: sin CAE y QR el comprobante no es válido ── */}
      {fiscal?.cae && (
        <>
          <div className="ticket-center ticket-small">CAE N° {fiscal.cae}</div>
          {fiscal.caeExpiry && (
            <div className="ticket-center ticket-small">
              Vto. CAE: {new Date(fiscal.caeExpiry).toLocaleDateString('es-AR')}
            </div>
          )}
          {fiscal.qrDataUrl && (
            <div className="ticket-center">
              <img className="ticket-qr" src={fiscal.qrDataUrl} alt="Código QR del comprobante" />
            </div>
          )}
          <div className="ticket-sep">{SEP_EQ}</div>
        </>
      )}

      {/* ── Pie ─────────────────────────────────────────────── */}
      <div className="ticket-center ticket-bold">¡Gracias por su compra!</div>

      <div className="ticket-spacer" />
    </div>
  )
}
