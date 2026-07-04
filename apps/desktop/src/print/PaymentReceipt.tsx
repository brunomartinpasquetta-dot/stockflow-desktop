/**
 * Recibo de cobranza de cuenta corriente — mismo diseño de rollo térmico que
 * `SaleTicket`, pero en vez de artículos muestra el IMPORTE ENTREGADO y los
 * saldos (del comprobante y total de la cuenta).
 *
 * Se imprime vía `printNode` (window.print + driver del SO) para el diálogo/A4,
 * y vía ESC/POS crudo para la térmica silenciosa (ver `printPaymentReceipt.ts`).
 */
import type { CompanyDTO } from '@/types/api'
import { formatCurrency, formatDateTime } from '@/lib/format'

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
}

export function PaymentReceipt({ data }: { data: PaymentReceiptData }) {
  const { company, customerName, customerDoc, date, paymentMethod, amount } = data
  const { comprobanteRef, comprobanteBalance, accountBalance } = data

  return (
    <div className="ticket-root">
      {/* ── Datos del negocio ───────────────────────────────── */}
      <div className="ticket-double">{company.name}</div>
      {company.address && <div className="ticket-center ticket-small">{company.address}</div>}
      {company.phone && <div className="ticket-center ticket-small">Tel: {company.phone}</div>}
      {company.cuit && <div className="ticket-center ticket-small">CUIT: {company.cuit}</div>}

      <div className="ticket-sep">{SEP_EQ}</div>

      {/* ── Encabezado del recibo ───────────────────────────── */}
      <div className="ticket-center ticket-bold">RECIBO DE COBRANZA</div>
      <div className="ticket-center ticket-small">DOCUMENTO NO FISCAL</div>
      <div>Fecha: {formatDateTime(date)}</div>
      <div>Cliente: {customerName}</div>
      {customerDoc && <div>{customerDoc}</div>}
      {comprobanteRef && <div>Comprobante: {comprobanteRef}</div>}
      <div>Medio de pago: {paymentMethod}</div>

      <div className="ticket-sep">{SEP_EQ}</div>

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
