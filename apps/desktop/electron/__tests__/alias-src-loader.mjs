// Resolvedor para las pruebas que importan código de la pantalla (`src/`):
// traduce el alias `@/` de Vite a `apps/desktop/src/` y le deja el resto a tsx.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    return next(new URL(specifier.slice(2), new URL('../../src/', import.meta.url)).href, context);
  }
  return next(specifier, context);
}
