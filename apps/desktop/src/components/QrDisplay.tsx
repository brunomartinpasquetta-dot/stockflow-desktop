/**
 * Muestra el QR de cobro MercadoPago en un cuadro con marco del color primary.
 * Prefiere imagen embebida (base64) y cae a `qrUrl` como link visual si no hay base64.
 */
export function QrDisplay({ qrBase64, qrUrl }: { qrBase64?: string | null; qrUrl?: string | null }) {
  const src = qrBase64 ? `data:image/png;base64,${qrBase64}` : qrUrl ?? ''
  if (!src) {
    return (
      <div className="flex h-[280px] w-[280px] items-center justify-center rounded bg-muted text-sm text-muted-foreground">
        Sin QR disponible
      </div>
    )
  }
  return (
    <div className="rounded border-4 border-primary bg-white p-4">
      <img src={src} alt="QR MercadoPago" className="h-[280px] w-[280px] object-contain" />
    </div>
  )
}
