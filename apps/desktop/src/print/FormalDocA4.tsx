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
  /** Código del artículo. Si ninguna línea lo trae, la columna no se dibuja. */
  code?: string | null
  /** Alícuota de IVA del renglón ("21.00"). Sólo se muestra en Factura A. */
  vatRate?: string | null
  /** Descuento del renglón. Si ninguna línea tiene, la columna no se dibuja. */
  discount?: string | null
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
  customer: { name: string; doc?: string | null; vatCondition?: string | null; address?: string | null } | null
  /**
   * ORIGINAL / DUPLICADO / TRIPLICADO. Va arriba de todo, como en cualquier
   * talonario: quien recibe el papel tiene que saber qué copia tiene en la mano.
   */
  copyLabel?: string | null
  /** Condición de venta ("Contado", "Cuenta corriente"). */
  saleCondition?: string | null
  /**
   * DETALLE DE ALÍCUOTAS: cuánto IVA corresponde a cada tasa. Es lo primero que
   * mira el contador en una Factura A. Sólo tiene sentido cuando el IVA se
   * discrimina (letra A); en B y C el impuesto va dentro del precio.
   */
  vatBreakdown?: { rate: string; base: string; amount: string }[] | null
  /** Leyendas legales al pie (una por renglón). */
  legalNotes?: string[] | null
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
  /**
   * Datos fiscales del comprobante autorizado por ARCA. Cuando vienen, el PDF
   * incluye el pie obligatorio con CAE, vencimiento y el QR (RG 4892).
   */
  fiscal?: {
    cae: string
    caeExpiry?: string | null
    /**
     * QR de ARCA ya renderizado como data URL (imagen embebida). Se genera
     * localmente con `qrcode` — el comprobante tiene que poder imprimirse sin
     * internet.
     */
    qrDataUrl?: string | null
    /** Letra grande del comprobante (A/B/C) en el recuadro central. */
    letter?: 'A' | 'B' | 'C'
    /** Código de comprobante ARCA, va debajo de la letra. */
    voucherCode?: number
  } | null
}


export function FormalDocA4({ data }: { data: FormalDocData }) {
  const {
    company, title, number, meta, customer, lines, totals,
    payments, paymentNote, notes, footerNote, showCompanyHeader = true, fiscal,
    copyLabel, saleCondition, vatBreakdown, legalNotes,
  } = data
  const discountNum = Number(totals.discount ?? 0)
  const vatNum = Number(totals.vatAmount ?? 0)

  // Las columnas opcionales sólo se dibujan si hay algo que poner. Una columna
  // vacía en las 40 líneas de una factura es peor que no tenerla: come ancho
  // que necesita la descripción.
  const showCode = lines.some((l) => (l.code ?? '').trim().length > 0)
  const showDiscount = lines.some((l) => Number(l.discount ?? 0) > 0)
  // El IVA por renglón se discrimina SÓLO en la A. En B y C está dentro del
  // precio y mostrarlo aparte es un error fiscal.
  const showVatCol = fiscal?.letter === 'A' && lines.some((l) => l.vatRate != null)
  const descWidth = 100 - (showCode ? 14 : 0) - 10 - 14 - (showDiscount ? 8 : 0) - (showVatCol ? 7 : 0) - 14

  return (
    <div className="doc-a4">
      {copyLabel && <div className="doc-copy">{copyLabel}</div>}
      {/* Encabezado: empresa (izq) + recuadro del comprobante (der) */}
      <div className="doc-head">
        <div>
          {showCompanyHeader ? (
            <>
              {/* Logo del comercio, si lo cargó en Mi Empresa. */}
              {company.logoDataUrl && (
                <img className="doc-logo" src={company.logoDataUrl} alt="" />
              )}
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
        {/* Letra del comprobante en el centro, como exige el formato de ARCA. */}
        {fiscal?.letter && (
          <div className="doc-letter-box">
            <div className="doc-letter">{fiscal.letter}</div>
            {fiscal.voucherCode != null && (
              <div className="doc-letter-code">COD. {String(fiscal.voucherCode).padStart(2, '0')}</div>
            )}
          </div>
        )}
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
          {customer?.address && <div>{customer.address}</div>}
          {/* Condición frente al IVA del receptor: obligatoria en el comprobante. */}
          <div>{customer?.vatCondition ?? 'Consumidor Final'}</div>
          {saleCondition && <div>Condición de venta: {saleCondition}</div>}
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
            {showCode && <th style={{ width: '14%' }}>Código</th>}
            <th style={{ width: `${descWidth}%` }}>Descripción</th>
            <th className="num" style={{ width: '10%' }}>Cant.</th>
            <th className="num" style={{ width: '14%' }}>P. unit.</th>
            {showDiscount && <th className="num" style={{ width: '8%' }}>Dto.</th>}
            {showVatCol && <th className="num" style={{ width: '7%' }}>IVA</th>}
            <th className="num" style={{ width: '14%' }}>Importe</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} style={{ pageBreakInside: 'avoid' }}>
              {showCode && <td className="doc-code">{l.code ?? ''}</td>}
              <td>{l.description}</td>
              <td className="num">{formatQty(l.quantity)}</td>
              <td className="num">{formatCurrency(l.unitPrice)}</td>
              {showDiscount && (
                <td className="num">
                  {Number(l.discount ?? 0) > 0 ? formatCurrency(l.discount ?? '0') : ''}
                </td>
              )}
              {showVatCol && <td className="num">{l.vatRate ? `${Number(l.vatRate)}%` : ''}</td>}
              <td className="num">{formatCurrency(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Empuja los totales y el pie fiscal AL FONDO de la hoja: así el
          comprobante ocupa la página entera en vez de quedar amontonado
          arriba, como en los talonarios preimpresos. */}
      <div className="doc-fill" />

      {/* DETALLE DE ALÍCUOTAS — lo primero que mira el contador en una A. */}
      {vatBreakdown && vatBreakdown.length > 0 && (
        <div className="doc-vat-breakdown">
          <div className="doc-party-label">Detalle de alícuotas</div>
          <table>
            <thead>
              <tr>
                <th>Alícuota</th>
                <th className="num">Neto gravado</th>
                <th className="num">IVA</th>
              </tr>
            </thead>
            <tbody>
              {vatBreakdown.map((v, i) => (
                <tr key={i}>
                  <td>IVA {Number(v.rate)}%</td>
                  <td className="num">{formatCurrency(v.base)}</td>
                  <td className="num">{formatCurrency(v.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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

      {/* Pie fiscal obligatorio: QR (RG 4892) + CAE y su vencimiento. */}
      {fiscal?.cae && (
        <div className="doc-fiscal">
          {fiscal.qrDataUrl && (
            <img className="doc-qr" src={fiscal.qrDataUrl} alt="Código QR del comprobante" />
          )}
          <div className="doc-fiscal-data">
            <div><strong>CAE N°:</strong> {fiscal.cae}</div>
            {fiscal.caeExpiry && <div><strong>Vencimiento del CAE:</strong> {fiscal.caeExpiry}</div>}
            <div className="doc-fiscal-note">Comprobante autorizado por ARCA</div>
          </div>
        </div>
      )}

      {legalNotes && legalNotes.length > 0 && (
        <div className="doc-legal">
          {legalNotes.map((t, i) => <div key={i}>{t}</div>)}
        </div>
      )}

      {footerNote && <div className="doc-footer">{footerNote}</div>}
    </div>
  )
}
