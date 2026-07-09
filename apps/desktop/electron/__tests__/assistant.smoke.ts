/**
 * Pruebas del motor conversacional de Flowy (offline). Corre con:
 *   pnpm --filter @stockflow/desktop test:assistant
 *
 * (1) Single-shot: preguntas típicas resuelven a respuesta útil (no fallback).
 * (2) Conversación: diálogos multi-turno que ejercitan CONTEXTO, seguimientos
 *     referenciales, reexplicación, desambiguación y charla humana.
 */
import { answerQuestion } from '../assistant/engine';

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

console.log(fails === 0 ? '\n✅ TODO OK' : `\n❌ ${fails} FALLAS`)
process.exit(fails === 0 ? 0 : 1)
