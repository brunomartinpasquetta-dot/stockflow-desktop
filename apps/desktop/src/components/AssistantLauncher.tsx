/**
 * Botón flotante para abrir Flowy en las ventanas de módulo (EmbeddedWindow),
 * que no tienen StatusBar. Fijo abajo a la derecha, mismo cubo que el botón
 * de la barra principal. Se oculta mientras el panel está abierto.
 */
import { BRANDING } from '@/assets/branding'
import { useAssistant } from '@/contexts/AssistantContext'

export function AssistantLauncher() {
  const { state, show } = useAssistant()
  if (state === 'open') return null
  return (
    <button
      type="button"
      onClick={show}
      title="Flowy — Asistente de StockFlow"
      aria-label="Abrir el asistente Flowy"
      className="fixed bottom-4 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border bg-background shadow-lg transition hover:scale-105 hover:border-primary"
    >
      <img src={BRANDING.iconSvg} alt="" className="h-6 w-6" draggable={false} />
    </button>
  )
}
