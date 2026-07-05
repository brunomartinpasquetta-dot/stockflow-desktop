/**
 * Utilidades de WhatsApp (POC): normaliza un teléfono al formato internacional
 * que espera WhatsApp (sin símbolos, con código de país) y abre el chat en el
 * panel embebido.
 *
 * Normalización pensada para Argentina: `54 9 + código de área (sin 0) + número
 * (sin 15)`. Es best-effort — si el número está mal cargado o es fijo, puede no
 * abrir el chat correcto.
 */
import { api } from '@/lib/api'

/** Convierte un teléfono "a la argentina" al formato de WhatsApp (E.164 sin +). */
export function toWhatsAppNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = raw.replace(/\D/g, '')
  if (!d) return null

  // Prefijo internacional "00"
  if (d.startsWith('00')) d = d.slice(2)

  // Ya trae código de país 54
  if (d.startsWith('54')) {
    let rest = d.slice(2)
    if (rest.startsWith('9')) rest = rest.slice(1) // lo re-agregamos al final
    rest = rest.replace(/^0/, '')
    rest = rest.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2') // quitar 15 si quedó
    return rest.length >= 8 ? `549${rest}` : null
  }

  // Número local: quitar 0 de trunk y 15 de celular (heurística por código de área)
  d = d.replace(/^0/, '')
  d = d.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2')
  return d.length >= 8 ? `549${d}` : null
}

/** Abre el chat del contacto en el panel de WhatsApp (si el número es válido). */
export function openWhatsAppChat(raw: string | null | undefined): boolean {
  const phone = toWhatsAppNumber(raw)
  if (!phone) return false
  void api.whatsapp.openChat(phone)
  return true
}
