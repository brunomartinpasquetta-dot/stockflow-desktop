import { ApiError } from '@/lib/api'

/**
 * Texto para mostrarle al usuario cuando falla una llamada: el mensaje del
 * servidor si vino (`ApiError`), el del error si es uno común, y si no el
 * texto por defecto que pasa la pantalla.
 */
export function mensajeError(e: unknown, porDefecto = 'No se pudo completar la operación.'): string {
  if (e instanceof ApiError) return e.message
  return e instanceof Error ? e.message : porDefecto
}
