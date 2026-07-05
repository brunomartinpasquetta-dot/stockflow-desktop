/**
 * Botón de WhatsApp para abrir el chat de un contacto (cliente/proveedor) en el
 * panel embebido. Se deshabilita si no hay un teléfono usable.
 */
import { toast } from 'sonner'

import { WhatsAppGlyph } from '@/components/WhatsAppGlyph'
import { openWhatsAppChat, toWhatsAppNumber } from '@/lib/whatsapp'
import { cn } from '@/lib/utils'

export function WhatsAppButton({
  phone,
  className,
}: {
  phone: string | null | undefined
  className?: string
}) {
  const valid = !!toWhatsAppNumber(phone)
  return (
    <button
      type="button"
      title={valid ? 'Abrir chat de WhatsApp' : 'Sin teléfono válido'}
      disabled={!valid}
      onClick={(e) => {
        e.stopPropagation()
        if (!openWhatsAppChat(phone)) toast.error('El contacto no tiene un teléfono válido')
      }}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#25D366] transition-colors',
        'hover:bg-[#25D366]/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366]/40',
        'disabled:cursor-not-allowed disabled:text-muted-foreground/40 disabled:hover:bg-transparent',
        className,
      )}
    >
      <WhatsAppGlyph className="h-4 w-4" strokeWidth={2} />
    </button>
  )
}
