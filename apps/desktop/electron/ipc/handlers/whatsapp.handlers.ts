/**
 * Handler del panel de WhatsApp (POC): abrir el chat de un contacto.
 *
 * Cualquier ventana pide `whatsapp:open-chat` con el número ya normalizado; el
 * main trae la ventana principal al frente y le avisa (`whatsapp:navigate`) para
 * que el panel embebido cargue esa conversación.
 */
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';

export function buildWhatsAppHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'whatsapp:open-chat': unguarded(
      deps,
      (payload: { phone: string }, d): { ok: true } => {
        d.focusMainWindow?.();
        d.emit('whatsapp:navigate', payload.phone);
        return { ok: true };
      },
    ),
  };
}
