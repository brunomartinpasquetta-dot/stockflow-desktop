/**
 * Cartel A4 con el QR de cobro de Mercado Pago, para pegar en el mostrador.
 *
 * El QR es SIEMPRE EL MISMO (pedido de Bruno, 8-oct-2026): se imprime una vez
 * por caja y el importe de cada venta viaja aparte. Por eso el cartel no lleva
 * ningún monto.
 */
import type { CompanyDTO } from '@/types/api'

export interface QrCartelData {
  company: CompanyDTO | null
  /** Número de la caja, para distinguir los carteles cuando hay varias. */
  numeroDeCaja?: number
  /** Imagen del QR en base64 (sin encabezado) o, si no está, su dirección. */
  qrImageBase64: string | null
  qrUrl: string
}

export function QrCartel({ data }: { data: QrCartelData }) {
  const { company, numeroDeCaja, qrImageBase64, qrUrl } = data
  const src = qrImageBase64 ? `data:image/png;base64,${qrImageBase64}` : qrUrl

  return (
    <div className="print-a4 text-center">
      <div className="text-2xl font-bold uppercase">{company?.name ?? 'Pagá con Mercado Pago'}</div>

      <div className="mt-6 text-3xl font-bold">Pagá con tu celular</div>
      <div className="mt-1 text-lg">Escaneá este código con la aplicación de Mercado Pago</div>

      <div className="mt-6 flex justify-center">
        {/* El QR tiene que salir grande: se escanea desde el otro lado del mostrador. */}
        <img src={src} alt="Código QR de Mercado Pago" style={{ width: '120mm', height: '120mm' }} />
      </div>

      <div className="mt-6 text-base">
        El importe lo carga la caja. Usted sólo escanea y confirma.
      </div>

      {numeroDeCaja !== undefined && (
        <div className="mt-8 text-xs text-gray-500">Caja {numeroDeCaja}</div>
      )}
    </div>
  )
}
