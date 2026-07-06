/**
 * Mapa de capturas del sistema para el asistente Sofía.
 * Vite empaqueta cada PNG y devuelve su URL; armamos { nombre.png -> url }.
 */
const modules = import.meta.glob<string>('../assets/sofia-shots/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

const SHOTS: Record<string, string> = {}
for (const [path, url] of Object.entries(modules)) {
  const name = path.split('/').pop()
  if (name) SHOTS[name] = url
}

/** Devuelve la URL de la captura por nombre de archivo, o null si no existe. */
export function shotUrl(name?: string | null): string | null {
  if (!name) return null
  return SHOTS[name] ?? null
}
