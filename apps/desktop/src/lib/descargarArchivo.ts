/**
 * Guardar un archivo en el disco desde la pantalla.
 *
 * Por qué existe (pedido de Bruno, 8-oct-2026): «Imprimir» manda el cartel
 * directo a la impresora y nunca ofrece guardar, así que el comercio no podía
 * llevarse el QR en un archivo (mandarlo a una imprenta, pegarlo en un cartel
 * hecho aparte, imprimirlo desde otra computadora). Esto baja el archivo igual
 * que la exportación a Excel, que ya funciona así en todos los clientes, y
 * también sirve en la terminal por navegador.
 */

/** Dispara la descarga de un blob con el nombre indicado. */
export function descargarBlob(nombre: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = nombre
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Dar tiempo a que el navegador tome el blob antes de liberarlo.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}

/** Convierte base64 (sin encabezado) en un blob del tipo indicado. */
export function blobDesdeBase64(base64: string, tipo: string): Blob {
  const binario = atob(base64)
  const bytes = new Uint8Array(binario.length)
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i)
  return new Blob([bytes], { type: tipo })
}

/**
 * Baja una imagen que puede venir en base64 (lo normal) o sólo como dirección
 * de internet (cuando no se pudo guardar la copia local).
 */
export async function descargarImagen(
  nombre: string,
  origen: { base64: string | null; url: string },
): Promise<void> {
  if (origen.base64) {
    descargarBlob(nombre, blobDesdeBase64(origen.base64, 'image/png'))
    return
  }
  if (!origen.url) throw new Error('No hay imagen para descargar.')
  const res = await fetch(origen.url)
  if (!res.ok) throw new Error(`No se pudo bajar la imagen (${res.status}).`)
  descargarBlob(nombre, await res.blob())
}

/** Deja el nombre del archivo sin caracteres que el sistema no acepta. */
export function nombreDeArchivo(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}
