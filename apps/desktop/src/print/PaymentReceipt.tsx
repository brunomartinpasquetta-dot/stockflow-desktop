/**
 * Recibo de cobranza de cuenta corriente — mismo diseño de rollo térmico que
 * `SaleTicket`, pero en vez de artículos muestra el IMPORTE ENTREGADO y los
 * saldos (del comprobante y total de la cuenta).
 *
 * Se imprime vía `printNode` (window.print + driver del SO) para el diálogo/A4,
 * y vía ESC/POS crudo para la térmica silenciosa (ver `printPaymentReceipt.ts`).
 */
import type { CompanyDTO } from '@/types/api'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'

const WIDTH = 32
const SEP_EQ = '='.repeat(WIDTH)
const SEP_DASH = '-'.repeat(WIDTH)

export interface PaymentReceiptData {
  company: CompanyDTO
  /** Nombre del cliente ("Apellido, Nombre"). */
  customerName: string
  /** Documento del cliente ("DNI 12345678"); `null` si no aplica. */
  customerDoc: string | null
  /** Fecha/hora del pago (epoch ms). */
  date: number
  /** Medio de pago de la cobranza. */
  paymentMethod: string
  /** Importe entregado por el cliente. */
  amount: string
  /** "Venta X #12" del comprobante imputado; `null` si no aplica. */
  comprobanteRef: string | null
  /** Saldo del comprobante luego del pago; `null` si no aplica. */
  comprobanteBalance: string | null
  /** Saldo total de la cuenta del cliente luego del pago. */
  accountBalance: string
  /** Título del comprobante (default "RECIBO DE COBRANZA"). */
  title?: string
  /** Rótulo de la contraparte (default "Cliente"; en proveedores, "Proveedor"). */
  partyLabel?: string
  /**
   * Detalle del período cobrado/pagado (cuando la operación sale de un filtro
   * por rango de fechas): lista de movimientos comprendidos + totales.
   */
  period?: {
    from: number
    to: number
    lines: { date: number; label: string; amount: string }[]
    /** Total de cargos del período (ventas / compras). */
    charges: string
    /** Total de pagos previos dentro del período. */
    payments: string
  }
}

export function PaymentReceipt({ data }: { data: PaymentReceiptData }) {
  const { company, customerName, customerDoc, date, paymentMethod, amount } = data
  const { comprobanteRef, comprobanteBalance, accountBalance, period } = data
  const title = data.title ?? 'RECIBO DE COBRANZA'
  const partyLabel = data.partyLabel ?? 'Cliente'

  return (
    <div className="ticket-root">
      {/* ── Datos del negocio ───────────────────────────────── */}
      <div className="ticket-double">{company.name}</div>
      {company.address && <div className="ticket-center ticket-small">{company.address}</div>}
      {company.phone && <div className="ticket-center ticket-small">Tel: {company.phone}</div>}
      {company.cuit && <div className="ticket-center ticket-small">CUIT: {company.cuit}</div>}

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Encabezado del recibo ───────────────────────────── */}
      <div className="ticket-center ticket-bold">{title}</div>
      <div className="ticket-center ticket-small">DOCUMENTO NO FISCAL</div>
      <div>Fecha: {formatDateTime(date)}</div>
      <div>{partyLabel}: {customerName}</div>
      {customerDoc && <div>{customerDoc}</div>}
      {comprobanteRef && <div>Comprobante: {comprobanteRef}</div>}
      <div>Medio de pago: {paymentMethod}</div>

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Detalle del período (cobro por rango de fechas) ─── */}
      {period && (
        <>
          <div className="ticket-center ticket-bold">
            DETALLE {formatDate(period.from)} AL {formatDate(period.to)}
          </div>
          <div className="ticket-sep">{SEP_DASH}</div>
          {period.lines.map((l, i) => (
            <div className="ticket-row" key={i}>
              <span>{formatDate(l.date)} {l.label}</span>
              <span>{formatCurrency(l.amount)}</span>
            </div>
          ))}
          <div className="ticket-sep">{SEP_DASH}</div>
          <div className="ticket-row">
            <span>Total período:</span>
            <span>{formatCurrency(period.charges)}</span>
          </div>
          {Number(period.payments) > 0.005 && (
            <div className="ticket-row">
              <span>Pagos del período:</span>
              <span>-{formatCurrency(period.payments)}</span>
            </div>
          )}
          <div className="ticket-sep">{SEP_EQ}</div>
        </>
      )}

      {/* ── Importe entregado ───────────────────────────────── */}
      <div className="ticket-row ticket-total">
        <span>ENTREGADO</span>
        <span>{formatCurrency(amount)}</span>
      </div>

      <div className="ticket-sep">{SEP_DASH}</div>

      {/* ── Saldos ──────────────────────────────────────────── */}
      {comprobanteBalance != null && (
        <div className="ticket-row">
          <span>Saldo comprobante:</span>
          <span>{formatCurrency(comprobanteBalance)}</span>
        </div>
      )}
      <div className="ticket-row ticket-bold">
        <span>Saldo total cuenta:</span>
        <span>{formatCurrency(accountBalance)}</span>
      </div>

      <div className="ticket-sep">{SEP_EQ}</div>

      <div className="ticket-center ticket-small">Comprobante de pago</div>

      <div className="ticket-spacer" />
    </div>
  )
}
