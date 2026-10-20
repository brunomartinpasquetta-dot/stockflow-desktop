/**
 * Defensa de pantalla para los casilleros numéricos (19-oct-2026).
 *
 * El lector de códigos de barras «tipea» donde esté el cursor. Si el cursor
 * estaba en una cantidad, un precio, un pago o el «Paga con», el código
 * entraba como valor (77.900.000.000.311 unidades; $985 mil billones de total).
 * Acá está la decisión, pura y testeable, que usan `CurrencyInput` y
 * `QuantityInput` al terminar de editar (salir del casillero o Enter):
 *
 *  - lo que tiene forma de código de barras NO se acepta;
 *  - lo que supera el tope del servidor (`limites.ts`) NO se acepta;
 *  - lo demás pasa (la confirmación de las cantidades altas, que sí pueden ser
 *    ciertas, la pide cada pantalla: ver `cantidadSospechosa`).
 *
 * Ventas decide por su cuenta la cantidad, el precio y el descuento de un
 * renglón (además de rechazar, carga el artículo si el código es de uno), pero
 * usa el mismo tope y los mismos avisos de acá.
 */
import { parseCurrencyInput, toInputString } from './format'
import { MENSAJE_CANTIDAD_ALTA, MENSAJE_IMPORTE_ALTO, mensajeDeTope, superaElTope, type ClaveDeTope } from './topes'

/** Qué se está cargando: define el tope y el texto del aviso. */
export type TipoDeEntrada = ClaveDeTope

export type DecisionDeEntrada =
  | { tipo: 'aceptar' }
  /** Tiene pinta de código de barras escaneado por error. */
  | { tipo: 'codigo'; mensaje: string }
  /** Supera el tope que el servidor rechazaría igual. */
  | { tipo: 'excede'; mensaje: string }

/** Es cantidad (cantidad/stock) o importe (precio/importe): cambia la palabra del aviso. */
const esCantidad = (t: TipoDeEntrada): boolean => t === 'cantidad' || t === 'stock'

/** Aviso cuando lo escrito parece un código de barras. */
export function avisoDeCodigoEnCasillero(tipo: TipoDeEntrada): string {
  return esCantidad(tipo)
    ? 'La cantidad ingresada parece un código de barras escaneado por error. Se mantuvo el valor anterior.'
    : 'El importe ingresado parece un código de barras escaneado por error. Se mantuvo el valor anterior. ' +
        'Si el importe es correcto, escríbalo con puntos de miles (por ejemplo 12.000.000).'
}

/**
 * ¿Qué hacer con lo que se escribió en un casillero numérico al terminar de editarlo?
 *
 * `texto`: lo escrito tal cual se ve en el campo. `anterior`: el valor que
 * tenía al entrar, en la misma forma (el lector escribe pegado a eso). Si no
 * cambió, no hay nada que decidir: un dato viejo que ya estaba (incluso alto)
 * no se vuelve a juzgar.
 */
export function evaluarEntrada(tipo: TipoDeEntrada, texto: string, anterior = ''): DecisionDeEntrada {
  const t = String(texto ?? '').trim()
  if (t === '' || t === String(anterior ?? '').trim()) return { tipo: 'aceptar' }
  // Sólo dígitos y ocho o más: EAN-8 para arriba. Lo tipeado con coma o punto
  // (1234,50 / 12.000.000) nunca es un código. NO se compara con los códigos del
  // padrón: un artículo de código interno «5» no vuelve código a la cantidad 5.
  if (/^\d{8,}$/.test(t)) {
    return { tipo: 'codigo', mensaje: avisoDeCodigoEnCasillero(tipo) }
  }
  // El código que quedó PEGADO a un valor con decimales («10.000» + «7791234567890»): ningún
  // casillero admite ocho decimales, así que esa cola no puede ser un importe ni una cantidad.
  if (/[.,]\d{8,}$/.test(t)) return { tipo: 'codigo', mensaje: avisoDeCodigoEnCasillero(tipo) }
  if (superaElTope(parseCurrencyInput(t), tipo)) {
    return { tipo: 'excede', mensaje: mensajeDeTope(tipo) }
  }
  return { tipo: 'aceptar' }
}

/** Aviso cuando un porcentaje no está entre 0 y 100 (o es un código de barras). */
export const AVISO_PORCENTAJE =
  'El porcentaje ingresado no es válido: debe estar entre 0 y 100. Verifique que no sea un código de barras.'

/** Un porcentaje de descuento es un número de 0 a 100 (vacío = todavía sin cargar). */
export function porcentajeValido(texto: string): boolean {
  const t = String(texto ?? '').trim()
  if (t === '') return true
  const n = Number(t.replace(',', '.'))
  return Number.isFinite(n) && n >= 0 && n <= 100
}

/** El valor canónico (`"1234.5"`) en la forma en que se ve mientras se edita (`"1234,5"`). */
export function comoSeEdita(canonico: string | number | null | undefined): string {
  return toInputString(canonico)
}

/**
 * Para los renglones de Ventas, Compras y Presupuestos, antes de enviar:
 * ¿algún valor del carrito supera el tope? Es la última defensa de pantalla:
 * cubre el caso de apretar F2 con el cursor todavía en un casillero (el valor
 * tipeado ya está en el carrito aunque el campo no haya terminado de editarse).
 * Devuelve el aviso o `null` si todo está dentro de lo razonable.
 */
export function primerExcesoDelCarrito(
  lineas: ReadonlyArray<{ cantidad?: string; precio?: string; descuento?: string }>,
  extra: { descuentoGlobal?: string; total?: string | number } = {},
): string | null {
  for (const l of lineas) {
    if (l.cantidad != null && superaElTope(parseCurrencyInput(l.cantidad), 'cantidad')) return MENSAJE_CANTIDAD_ALTA
    if (l.precio != null && superaElTope(parseCurrencyInput(l.precio), 'precio')) return MENSAJE_IMPORTE_ALTO
    if (l.descuento != null && superaElTope(parseCurrencyInput(l.descuento), 'precio')) return MENSAJE_IMPORTE_ALTO
  }
  if (extra.descuentoGlobal != null && superaElTope(parseCurrencyInput(extra.descuentoGlobal), 'importe')) return MENSAJE_IMPORTE_ALTO
  if (extra.total != null && superaElTope(extra.total, 'importe')) return MENSAJE_IMPORTE_ALTO
  return null
}
