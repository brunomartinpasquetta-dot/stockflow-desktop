/**
 * Pruebas del motor conversacional de Flowy (offline). Corre con:
 *   pnpm --filter @stockflow/desktop test:assistant
 *
 * (1) Single-shot: preguntas típicas resuelven a respuesta útil (no fallback).
 * (2) Conversación: diálogos multi-turno que ejercitan CONTEXTO, seguimientos
 *     referenciales, reexplicación, desambiguación y charla humana.
 */
import { answerQuestion, lastResolved } from '../assistant/engine';

let convSeq = 0
const freshId = (): string => `t${convSeq++}`

const FALLBACK = 'no lo tengo claro'
let fails = 0

/* ---------- (1) single-shot ---------- */
const SINGLE = [
  'como hago una venta', 'quiero cobrarle a un cliente', 'como cargo un producto nuevo',
  'alta de mercaderia', 'no me anda la impresora', 'como imprimo un ticket', 'abrir la caja',
  'cierre de caja', 'fiado', 'cta cte de un cliente', 'como hago un presupuesto',
  'convertir presupuesto en venta', 'stock minimo', 'listas de precios', 'como agrego un usuario nuevo',
  'permisos de un empleado', 'actualizar precios de golpe', 'escanear codigo de barras',
  'como activo la licencia', 'backup de los datos',
  // typos:
  'como ago una benta', 'kiero cargar un articulo', 'imprimr un tiket',
  // novedades v0.1.82-86:
  'como cobro el mes de un cliente', 'filtrar la cuenta corriente por fechas',
  'buscar articulos por marca', 'porque se cambia sola la lista de precios',
  'lista 2 en cero no se actualiza',
]
console.log('── Single-shot ──')
for (const q of SINGLE) {
  const r = answerQuestion(q, freshId())
  const ok = !r.reply.includes(FALLBACK) && r.reply.length > 10
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} "${q}"  →  ${r.reply.replace(/\n/g, ' ⏎ ').slice(0, 80)}`)
}

/* ---------- (2) charla ---------- */
console.log('\n── Charla / meta ──')
const META: [string, string][] = [
  ['hola', 'Flowy'],
  ['gracias!', ''],
  ['sos un robot?', ''],
  ['en que me ayudas', ''],
  ['que hora es', ''],
  ['no funciona nada estoy perdido', ''],
]
for (const [q] of META) {
  const r = answerQuestion(q, freshId())
  const ok = r.reply.length > 5 && !r.reply.includes(FALLBACK)
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} "${q}"  →  ${r.reply.replace(/\n/g, ' ⏎ ').slice(0, 75)}`)
}

/* ---------- (3) diálogos multi-turno (CONTEXTO) ---------- */
console.log('\n── Conversación multi-turno ──')
interface Turn { user: string; expect: (reply: string) => boolean; why: string }
const DIALOGS: { title: string; turns: Turn[] }[] = [
  {
    title: 'Cargar un artículo y luego editarlo (seguimiento referencial)',
    turns: [
      { user: 'como cargo un producto', expect: (r) => /nuevo|codigo|descripci/i.test(r), why: 'entiende alta de artículo' },
      { user: 'y para modificarlo?', expect: (r) => /modific|edit|cambi/i.test(r), why: 'seguimiento: usa contexto para ir a editar' },
      { user: 'no entendi', expect: (r) => /paso|despacio|otras palabras|trabaste/i.test(r), why: 'reexplica lo último' },
    ],
  },
  {
    title: 'Venta paso a paso con "y después"',
    turns: [
      { user: 'como hago una venta', expect: (r) => /1\.|paso|ventas/i.test(r), why: 'da pasos de venta' },
      { user: 'y despues?', expect: (r) => /paso|termin|siguiente|trabaste/i.test(r), why: 'responde al "y después" con contexto' },
      { user: 'gracias', expect: (r) => /nada|dale|genia|ando|estoy/i.test(r), why: 'cierra con charla' },
    ],
  },
  {
    title: 'Oferta de tema relacionado + "sí"',
    turns: [
      { user: 'como cobro con qr', expect: (r) => /qr|mercadopago|mercado pago/i.test(r), why: 'responde QR' },
      { user: 'dale', expect: (r) => r.length > 15 && !/no lo tengo/i.test(r), why: 'acepta la oferta relacionada' },
    ],
  },
  {
    // REGRESIÓN (v0.1.86): "si" es stopword → tokeniza a vacío → devolvía el
    // SALUDO en vez de aceptar la oferta pendiente (reportado por Bruno con
    // "como conectar mercado pago" → oferta → "si" → "¡Hola! Soy Flowy…").
    title: 'Oferta pendiente + "si" seco (stopword) NO debe saludar',
    turns: [
      { user: 'como conectar mercado pago', expect: (r) => /mercado ?pago|qr|token/i.test(r), why: 'responde conexión MP' },
      { user: 'si', expect: (r) => !/soy flowy, tu asistente/i.test(r) && r.length > 15, why: 'acepta la oferta, no saluda' },
    ],
  },
  {
    title: 'Oferta pendiente + "no" seco suelta el contexto sin saludar',
    turns: [
      { user: 'como cobro con qr', expect: (r) => /qr|mercadopago|mercado pago/i.test(r), why: 'responde QR' },
      { user: 'no', expect: (r) => /no hay drama|contame/i.test(r), why: 'rechaza la oferta amablemente' },
    ],
  },
  {
    title: 'Modo guiado avanza con "si" y con "ya" (stopwords)',
    turns: [
      { user: 'como hago una venta', expect: (r) => /1\.|paso|ventas/i.test(r), why: 'da pasos de venta' },
      { user: 'guiame', expect: (r) => /paso 1/i.test(r), why: 'arranca guiado' },
      { user: 'si', expect: (r) => /paso 2/i.test(r), why: '"si" avanza al paso 2' },
      { user: 'ya', expect: (r) => /paso 3/i.test(r), why: '"ya" avanza al paso 3' },
    ],
  },
  {
    title: 'Más simple',
    turns: [
      { user: 'como abro la caja', expect: (r) => /caja|abr|saldo|inicial/i.test(r), why: 'abre caja' },
      { user: 'explicamelo mas facil', expect: (r) => /despacio|paso|trabaste|simple|tranqui/i.test(r), why: 'reexplica simple con contexto' },
    ],
  },
]

for (const d of DIALOGS) {
  console.log(`\n  ▸ ${d.title}`)
  const id = freshId()
  for (const t of d.turns) {
    const r = answerQuestion(t.user, id)
    const ok = t.expect(r.reply)
    if (!ok) fails++
    console.log(`    ${ok ? '✅' : '❌'} "${t.user}"  (${t.why})\n       → ${r.reply.replace(/\n/g, ' ⏎ ').slice(0, 90)}`)
  }
}

/* ---------- (4) contexto de PANTALLA (E1) ---------- */
console.log('\n── Contexto de pantalla ──')
const SCREEN_CASES: { q: string; screenArea: string; expectArea: string; why: string }[] = [
  { q: 'como agrego productos', screenArea: 'ventas', expectArea: 'ventas', why: 'ambigua ×3 áreas: parado en Ventas responde Ventas' },
  { q: 'como agrego productos', screenArea: 'presupuestos', expectArea: 'presupuestos', why: 'la misma pregunta en Presupuestos responde Presupuestos' },
  { q: 'como aplico un descuento global', screenArea: 'compras', expectArea: 'compras', why: 'descuento-global ×3 áreas: gana la pantalla' },
  { q: 'atajos de teclado', screenArea: 'articulos', expectArea: 'articulos', why: 'atajos ×3 áreas: gana la pantalla' },
]
for (const t of SCREEN_CASES) {
  const id = freshId()
  const r = answerQuestion(t.q, id, t.screenArea)
  const res = lastResolved(id)
  const ok = res?.area === t.expectArea && !r.reply.includes(FALLBACK)
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} "${t.q}" @${t.screenArea}  (${t.why})  → ${res ? `${res.area}/${res.id}` : 'sin intent (¿desambiguación?)'}`)
}
// La CONVERSACIÓN le gana a la pantalla: 'atajos de teclado' es pattern exacto
// de intro Y de articulos; con el hilo en articulos (aunque el usuario esté
// parado en Ventas) tiene que responder articulos. (Ojo: una frase que es
// pattern exacto de UNA sola área se responde con esa área aunque el hilo
// venga de otra — frase exacta = pedido explícito; ese caso no se testea acá.)
{
  const id = freshId()
  answerQuestion('como cargo un articulo nuevo', id, 'ventas')
  const before = lastResolved(id)
  answerQuestion('atajos de teclado', id, 'ventas')
  const after = lastResolved(id)
  const ok = before?.area === 'articulos' && after?.area === 'articulos' && after?.id === 'atajos-teclado'
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} hilo en articulos + pantalla ventas → atajos responde articulos  → ${after ? `${after.area}/${after.id}` : 'null'}`)
}

/* ---------- (5) acciones de navegación (E2) ---------- */
console.log('\n── Acciones de navegación ──')
const ACTION_CASES: { q: string; expectScreen: string }[] = [
  { q: 'como hago una venta', expectScreen: 'ventas' },
  { q: 'como configuro la impresora', expectScreen: 'configuracion' },
  { q: 'como importo mis articulos desde un excel', expectScreen: 'importar-stock' },
]
for (const t of ACTION_CASES) {
  const r = answerQuestion(t.q, freshId())
  const ok = (r.actions ?? []).some((a) => a.screen === t.expectScreen && a.label.length > 0)
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} "${t.q}" → botón a «${t.expectScreen}»  (${JSON.stringify(r.actions ?? [])})`)
}
// Una respuesta sin action en la KB no inventa botones.
{
  const r = answerQuestion('que es el stock minimo', freshId())
  const ok = (r.actions ?? []).length === 0
  if (!ok) fails++
  console.log(`${ok ? '✅' : '❌'} intent sin action → sin botones`)
}

console.log(fails === 0 ? '\n✅ TODO OK' : `\n❌ ${fails} FALLAS`)
process.exit(fails === 0 ? 0 : 1)
