/**
 * El lector de códigos de barras en Ventas.
 *
 * El lector «tipea» el código y un Enter. Si el foco no estaba en el buscador
 * (se tocó el tacho de un renglón, se hizo clic en el total o en la forma de
 * pago, se eligió un cliente), los dígitos se perdían y el Enter final
 * confirmaba la venta: se cobraba sin el artículo leído (16-oct-2026). Bruno
 * decidió que Enter ya NO confirma la venta (sólo F2 o el botón verde) y que el
 * foco vuelva siempre al buscador. Acá está la lógica pura de eso.
 */
import { cantidadSospechosa } from './cantidadSospechosa'

/** Lo mínimo que hace falta saber del elemento que tiene el foco. */
export interface ElementoConFoco {
  tagName?: string
  type?: string
  readOnly?: boolean
  isContentEditable?: boolean
}

/** Lo mínimo que hace falta saber de la tecla. */
export interface TeclaApretada {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}

/** Tipos de <input> en los que se escribe texto. */
const TIPOS_DE_TEXTO = new Set(['', 'text', 'search', 'number', 'tel', 'email', 'url', 'password'])

/**
 * ¿El foco está en un lugar donde se escribe? Ahí la tecla es del campo (la
 * cantidad de un renglón, el documento del cliente, el descuento) y no se la
 * desvía. Una casilla, una lista desplegable, un botón, un campo de sólo
 * lectura o el fondo de la pantalla no son lugares de escritura.
 */
export function esCampoDeTexto(el: ElementoConFoco | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = (el.tagName ?? '').toUpperCase()
  if (tag === 'TEXTAREA') return !el.readOnly
  if (tag === 'INPUT') return TIPOS_DE_TEXTO.has((el.type ?? '').toLowerCase()) && !el.readOnly
  return false
}

/**
 * ¿Es una tecla que escribe un carácter? Quedan afuera:
 *  - las teclas con nombre (Enter, Tab, flechas, F2…), que tienen su función;
 *  - el espacio, que tilda la casilla o aprieta el botón enfocado;
 *  - la barra «/», que es el atajo de la búsqueda general;
 *  - todo lo que va con Ctrl, Cmd o Alt (atajos).
 */
export function esTeclaDeTexto(t: TeclaApretada): boolean {
  if (t.ctrlKey || t.metaKey || t.altKey) return false
  if (t.key.length !== 1) return false
  return t.key !== ' ' && t.key !== '/'
}

export interface SituacionDeLaTecla {
  tecla: TeclaApretada
  /** El elemento que tiene el foco (null = nada / el fondo). */
  foco: ElementoConFoco | null
  /** El foco ya está en el buscador de Ventas. */
  focoEnElBuscador: boolean
  /** Hay un diálogo abierto (cliente, peso, vuelto, QR, devolución…). */
  dialogoAbierto: boolean
}

/**
 * ¿Hay que pasar el foco al buscador ANTES de que entre esta tecla? Así el
 * código completo del lector entra en el buscador aunque el cajero haya
 * tocado otra cosa antes.
 */
export function debeIrAlBuscador(s: SituacionDeLaTecla): boolean {
  if (s.dialogoAbierto || s.focoEnElBuscador) return false
  if (!esTeclaDeTexto(s.tecla)) return false
  return !esCampoDeTexto(s.foco)
}

/**
 * Qué hacer con la cantidad de un renglón al terminar de editarla (Enter o
 * salir del campo):
 *  - aceptar: es una cantidad normal;
 *  - codigo: tiene pinta de código de barras (se escaneó con el cursor en la
 *    cantidad). NO se acepta: vuelve la cantidad anterior y, si el código es
 *    de un artículo, ese artículo se carga en la venta;
 *  - preguntar: es inusualmente alta; se pide confirmación antes de aceptarla.
 */
export type DecisionCantidad = { tipo: 'aceptar' } | { tipo: 'codigo'; codigo: string } | { tipo: 'preguntar' }

/**
 * El lector escribe donde está el cursor: el código queda pegado a la cantidad
 * que ya había, antes o después (el caso real fue «7790000000031» + «1»). Si
 * sacando la cantidad anterior de una punta queda el código de un artículo, ese
 * es el código leído. Si no, se devuelve lo escrito tal cual.
 */
export function codigoDentroDeLaCantidad(
  texto: string,
  anterior: string,
  esCodigoConocido: (valor: string) => boolean = () => false,
): string {
  const t = String(texto ?? '').trim()
  const a = String(anterior ?? '').trim()
  const candidatos = [t]
  if (a && t.length > a.length) {
    if (t.startsWith(a)) candidatos.push(t.slice(a.length))
    if (t.endsWith(a)) candidatos.push(t.slice(0, t.length - a.length))
  }
  return candidatos.find((c) => esCodigoConocido(c)) ?? t
}

export function decidirCantidad(
  texto: string,
  anterior: string,
  esCodigoConocido: (valor: string) => boolean = () => false,
): DecisionCantidad {
  const t = String(texto ?? '').trim()
  // Lo que ya estaba (por ejemplo, una cantidad alta que ya se confirmó) no se vuelve a preguntar.
  if (t === String(anterior ?? '').trim()) return { tipo: 'aceptar' }
  const motivo = cantidadSospechosa(t, esCodigoConocido)
  if (motivo === 'parece-codigo') return { tipo: 'codigo', codigo: codigoDentroDeLaCantidad(t, anterior, esCodigoConocido) }
  if (motivo === 'muy-alta') return { tipo: 'preguntar' }
  return { tipo: 'aceptar' }
}

/** Los otros dos campos del renglón que el lector puede pisar. */
export type CampoDeImporte = 'precio' | 'descuento'

export type DecisionImporte = { tipo: 'aceptar' } | { tipo: 'codigo'; codigo: string }

/**
 * Qué hacer con el PRECIO o el DESCUENTO de un renglón al terminar de
 * editarlo. Misma protección que la cantidad, con una diferencia: sólo es
 * código lo que tiene forma de código de barras de verdad (sólo dígitos, ocho
 * o más: EAN-8 para arriba). NO se compara con los códigos cortos del padrón:
 * los comercios migrados tienen códigos internos como «100» o «1500» que
 * coinciden con los importes de todos los días, y un precio o un descuento
 * tipeado se descartaba y agregaba un artículo que nadie pidió. No se acepta
 * lo que parece código: vuelve el valor anterior y, si el código es de un
 * artículo, ese artículo se carga en la venta. Un importe alto NO se
 * pregunta: $12.000 es un precio normal, y lo tipeado con coma o punto
 * (1234,50) nunca es un código.
 *
 * `anterior` va en la forma en que se ve en el campo mientras se edita
 * («1500» / «1234,5»): el lector escribe pegado a eso.
 */
export function decidirImporte(
  texto: string,
  anterior: string,
  esCodigoConocido: (valor: string) => boolean = () => false,
): DecisionImporte {
  const t = String(texto ?? '').trim()
  if (t === String(anterior ?? '').trim()) return { tipo: 'aceptar' }
  // Sólo ocho dígitos o más: un código corto del padrón (100, 1500) es un importe.
  if (!/^\d{8,}$/.test(t) || cantidadSospechosa(t) !== 'parece-codigo') return { tipo: 'aceptar' }
  return { tipo: 'codigo', codigo: codigoDentroDeLaCantidad(t, anterior, esCodigoConocido) }
}

/** Aviso al cajero cuando el precio o el descuento resultaron ser un código escaneado. */
export function avisoImporteConCodigo(campo: CampoDeImporte, articulo: string | null): string {
  const que = campo === 'precio' ? 'El precio' : 'El descuento'
  const mantuvo = campo === 'precio' ? 'Se mantuvo el precio anterior' : 'Se mantuvo el descuento anterior'
  return articulo
    ? `${que} ingresado es el código de barras de «${articulo}». ${mantuvo} y el artículo se agregó a la venta.`
    : `${que} ingresado parece un código de barras escaneado por error. ${mantuvo}.`
}
