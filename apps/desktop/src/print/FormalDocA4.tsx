/**
 * Documento formal A4 con marco — base compartida para el TICKET A4 de venta y
 * el PDF de PRESUPUESTO. A diferencia del ticket térmico (58/80mm), ocupa el
 * ancho completo de la hoja, lleva encabezado de empresa recuadrado, tabla de
 * ítems con bordes y bloque de totales. Estilos en index.css (`.doc-a4`).
 *
 * Se imprime con `printNode(<FormalDocA4 .../>, 'a4')`.
 */
import type { CompanyDTO } from '@/types/api'
import { formatCurrency, formatQty } from '@/lib/format'

export interface FormalDocLine {
  description: string
  quantity: string
  unitPrice: string
  lineTotal: string
}

export interface FormalDocMeta {
  label: string
  value: string
}

export interface FormalDocTotals {
  subtotal: string
  /** Importe del descuento global (si > 0 se muestra). */
  discount?: string | null
  vatAmount?: string | null
  vatLabel?: string
  total: string
}

export interface FormalDocData {
  company: CompanyDTO
  /** Título grande del recuadro derecho, ej. "FACTURA B" o "PRESUPUESTO". */
  title: string
  /** Número ya formateado, ej. "00000123" o "P-0001". */
  number: string
  /** Filas de metadatos (Fecha, Vendedor, Vigencia…). */
  meta: FormalDocMeta[]
  /** Datos del cliente; null = Consumidor Final (igual se muestra el rótulo). */
  customer: { name: string; doc?: string | null } | null
  lines: FormalDocLine[]
  totals: FormalDocTotals
  /** Desglose de pagos (opcional, para el ticket de venta). */
  payments?: { methodName: string; amount: string }[]
  /** Texto de cuenta corriente / forma de pago única. */
  paymentNote?: string | null
  /** Observaciones libres (presupuesto). */
  notes?: string | null
  /** Pie centrado, ej. "¡Gracias por su compra!" o validez del presupuesto. */
  footerNote?: string | null
  /** Mostrar el encabezado de empresa (true por defecto). */
  showCompanyHeader?: boolean
}


export function FormalDocA4({ data }: { data: FormalDocData }) {
  const {
    company, title, number, meta, customer, lines, totals,
    payments, paymentNote, notes, footerNote, showCompanyHeader = true,
  } = data
  const discountNum = Number(totals.discount ?? 0)
  const vatNum = Number(totals.vatAmount ?? 0)

  return (
    <div className="doc-a4">
      {/* Encabezado: empresa (izq) + recuadro del comprobante (der) */}
      <div className="doc-head">
        <div>
          {showCompanyHeader ? (
            <>
              <div className="doc-company-name">{company.name}</div>
              <div className="doc-company-meta">
                {company.address && <div>{company.address}</div>}
                {company.phone && <div>Tel: {company.phone}</div>}
                {company.cuit && <div>CUIT: {company.cuit}</div>}
                {company.ingBrutos && <div>Ing. Brutos: {company.ingBrutos}</div>}
              </div>
            </>
          ) : (
            <div className="doc-company-name">{company.name}</div>
          )}
        </div>
        <div className="doc-title-box">
          <div className="doc-title">{title}</div>
          <div className="doc-number">N° {number}</div>
        </div>
      </div>

      {/* Cliente + metadatos */}
      <div className="doc-meta-row">
        <div className="doc-party">
          <div className="doc-party-label">Cliente</div>
          <div>{customer?.name ?? 'Consumidor Final'}</div>
          {customer?.doc && <div>{customer.doc}</div>}
        </div>
        <div className="doc-party" style={{ maxWidth: '70mm' }}>
          {meta.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: '6mm' }}>
              <span className="doc-party-label">{m.label}</span>
              <span>{m.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Detalle de ítems */}
      <table className="doc-items">
        <thead>
          <tr>
            <th style={{ width: '50%' }}>Descripción</th>
            <th className="num">Cant.</th>
            <th className="num">P. unit.</th>
            <th className="num">Importe</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} style={{ pageBreakInside: 'avoid' }}>
              <td>{l.description}</td>
              <td className="num">{formatQty(l.quantity)}</td>
              <td className="num">{formatCurrency(l.unitPrice)}</td>
              <td className="num">{formatCurrency(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totales */}
      <div className="doc-totals">
        <div className="row">
          <span>Subtotal</span>
          <span className="tabular-nums">{formatCurrency(totals.subtotal)}</span>
        </div>
        {discountNum > 0 && (
          <div className="row">
            <span>Descuento</span>
            <span className="tabular-nums">−{formatCurrency(totals.discount ?? '0')}</span>
          </div>
        )}
        {vatNum > 0 && (
          <div className="row">
            <span>{totals.vatLabel ?? 'IVA'}</span>
            <span className="tabular-nums">{formatCurrency(totals.vatAmount ?? '0')}</span>
          </div>
        )}
        <div className="row grand">
          <span>TOTAL</span>
          <span className="tabular-nums">{formatCurrency(totals.total)}</span>
        </div>
      </div>

      {/* Forma de pago */}
      {paymentNote ? (
        <div className="doc-notes"><strong>Forma de pago:</strong> {paymentNote}</div>
      ) : payments && payments.length > 0 ? (
        <div className="doc-notes">
          <strong>Forma de pago:</strong>
          {payments.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', maxWidth: '78mm' }}>
              <span>{p.methodName}</span>
              <span className="tabular-nums">{formatCurrency(p.amount)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {notes && (
        <div className="doc-notes"><strong>Observaciones:</strong> {notes}</div>
      )}

      {footerNote && <div className="doc-footer">{footerNote}</div>}
    </div>
  )
}
