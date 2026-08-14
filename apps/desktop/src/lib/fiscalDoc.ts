/**
 * Armado del comprobante fiscal A4 (factura / nota de crédito / débito) con CAE
 * y el QR obligatorio de ARCA (RG 4892).
 *
 * El QR se genera LOCALMENTE con `qrcode`: el comprobante tiene que poder
 * imprimirse aunque no haya internet.
 */
import QRCode from 'qrcode'

import type { FormalDocData } from '@/print/FormalDocA4'
import type { CompanyDTO, FiscalCategory, FiscalVoucherDTO, SaleDTO, SaleLineDTO } from '@/types/api'
import { formatDate } from '@/lib/format'

/**
 * Condición del cliente frente al IVA, tal como sale impresa en el comprobante:
 * es un dato obligatorio y va escrito entero, no con la sigla.
 */
export const VAT_CONDITION_LABELS: Record<FiscalCategory, string> = {
  RI: 'Responsable Inscripto',
  MT: 'Monotributo',
  CF: 'Consumidor Final',
  EX: 'Exento',
}

/** Nombre legible del comprobante para el título del documento. */
export function fiscalTitle(v: Pick<FiscalVoucherDTO, 'letter' | 'kind'>): string {
  const base =
    v.kind === 'credit_note'
      ? 'NOTA DE CRÉDITO'
      : v.kind === 'debit_note'
        ? 'NOTA DE DÉBITO'
        : 'FACTURA'
  return `${base} ${v.letter}`
}

/** Numeración fiscal formateada: 00001-00000042 */
export function fiscalNumber(v: Pick<FiscalVoucherDTO, 'salePoint' | 'number'>): string {
  return `${String(v.salePoint).padStart(5, '0')}-${String(v.number).padStart(8, '0')}`
}

/** YYYYMMDD (o epoch) → DD/MM/AAAA para mostrar. */
function fmtCaeExpiry(caeExpiry: number | null): string | null {
  if (!caeExpiry) return null
  return formatDate(caeExpiry)
}

/**
 * Genera el QR de ARCA como data URL. Si falla, devuelve null: el comprobante
 * se imprime igual (sin QR) en vez de romper la impresión.
 */
export async function buildQrDataUrl(qrUrl: string | null): Promise<string | null> {
  if (!qrUrl) return null
  try {
    return await QRCode.toDataURL(qrUrl, { margin: 0, width: 200 })
  } catch {
    return null
  }
}

export interface BuildFiscalDocInput {
  company: CompanyDTO
  voucher: FiscalVoucherDTO
  sale?: SaleDTO | null
  lines?: (SaleLineDTO & { description?: string })[]
  descriptionById?: Map<string, string>
  sellerName?: string | null
  paymentNote?: string | null
}

/**
 * Arma el documento A4 del comprobante fiscal, con su pie de CAE y QR.
 *
 * Para notas de crédito/débito sin líneas propias se muestra un único renglón
 * con el concepto y el importe, que es lo habitual en un ajuste.
 */
export async function buildFiscalDoc(input: BuildFiscalDocInput): Promise<FormalDocData> {
  const { company, voucher, sale, lines, descriptionById, sellerName, paymentNote } = input

  const qrDataUrl = await buildQrDataUrl(voucher.qrUrl)

  const docLines =
    lines && lines.length > 0
      ? lines.map((l) => ({
          description: l.description ?? descriptionById?.get(l.articleId) ?? 'Artículo',
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        }))
      : [
          {
            description:
              voucher.kind === 'credit_note'
                ? 'Nota de crédito sobre comprobante asociado'
                : voucher.kind === 'debit_note'
                  ? 'Nota de débito sobre comprobante asociado'
                  : 'Comprobante',
            quantity: '1',
            unitPrice: voucher.total,
            lineTotal: voucher.total,
          },
        ]

  const meta = [
    { label: 'Fecha', value: formatDate(voucher.date) },
    ...(sellerName ? [{ label: 'Vendedor', value: sellerName }] : []),
    ...(sale ? [{ label: 'Venta interna', value: `${sale.type} #${sale.number}` }] : []),
  ]

  // El IVA solo se discrimina en comprobantes A (en B/C va incluido en el precio).
  const showVat = voucher.letter === 'A' && Number(voucher.vatAmount) > 0

  return {
    company,
    title: fiscalTitle(voucher),
    number: fiscalNumber(voucher),
    meta,
    customer: {
      name: voucher.customerName,
      doc:
        voucher.customerDocType === 99
          ? null
          : `${voucher.customerDocType === 80 ? 'CUIT' : 'Doc'}: ${voucher.customerDocNumber}`,
    },
    lines: docLines,
    totals: {
      subtotal: showVat ? voucher.netAmount : voucher.total,
      vatAmount: showVat ? voucher.vatAmount : null,
      vatLabel: 'IVA',
      total: voucher.total,
    },
    paymentNote: paymentNote ?? null,
    footerNote: null,
    fiscal: {
      cae: voucher.cae ?? '',
      caeExpiry: fmtCaeExpiry(voucher.caeExpiry),
      qrDataUrl,
      letter: voucher.letter,
      voucherCode: voucher.voucherCode,
    },
  }
}
