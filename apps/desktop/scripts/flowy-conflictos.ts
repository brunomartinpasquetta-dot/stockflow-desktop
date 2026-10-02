/**
 * Reporte de CHOQUES en la base de Flowy: frases de fichas distintas que la IA
 * no puede separar. No necesita Ollama: usa los vectores del índice base.
 *
 *  1. Textos idénticos en fichas distintas (empate puro: decide el redondeo).
 *  2. Frases casi iguales (parecido ≥ 0,95) entre fichas distintas.
 *  3. Frases "imán": la más parecida a 5 o más frases de OTRAS fichas.
 *
 * Correr antes de publicar si se tocó intents.json (después de `flowy:indice`):
 *   pnpm --filter @stockflow/desktop flowy:conflictos [--json salida.json]
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { temasKB } from '../electron/assistant/engine';
import { ARCHIVO_INDICE_BASE, FlowyIA } from '../electron/assistant/ia/flowyIA';
import { IndiceSemantico } from '../electron/assistant/ia/semantico';

const aqui = dirname(fileURLToPath(import.meta.url));
const indice = IndiceSemantico.cargar(join(aqui, '..', 'electron', 'assistant', 'ia', ARCHIVO_INDICE_BASE));
if (!indice) {
  console.error('❌ No hay índice base: correr primero `pnpm flowy:indice`.');
  process.exit(1);
}
const { docs, huella } = FlowyIA.documentos();
if (huella !== indice.huella || docs.length !== indice.tamaño) {
  console.error('❌ El índice base no corresponde a la base actual: correr `pnpm flowy:indice`.');
  process.exit(1);
}

const temas = new Map(temasKB().map((t) => [`i:${t.gidx}`, t]));
const nombre = (clave: string): string => {
  const t = temas.get(clave);
  return t ? `${t.area}/${t.id}` : clave;
};
const mismoTema = (a: string, b: string): boolean => {
  const ta = temas.get(a);
  const tb = temas.get(b);
  // Gemelas (mismo id en otra área) no son un choque.
  return a === b || Boolean(ta && tb && ta.id === tb.id);
};

const idx = docs.map((d, i) => ({ ...d, i })).filter((d) => d.clave.startsWith('i:'));

// 1) Textos idénticos
const porTexto = new Map<string, string[]>();
for (const d of idx) {
  const k = d.texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]/g, '').trim();
  porTexto.set(k, [...(porTexto.get(k) ?? []), d.clave]);
}
const identicos = [...porTexto.entries()]
  .map(([texto, claves]) => ({ texto, fichas: [...new Set(claves)] }))
  .filter((x) => x.fichas.length > 1 && x.fichas.some((a, k) => x.fichas.slice(k + 1).some((b) => !mismoTema(a, b))))
  .map((x) => ({ texto: x.texto, fichas: x.fichas.map(nombre) }));

// 2) Casi iguales y 3) imanes
const casi: { a: string; fa: string; b: string; fb: string; parecido: number }[] = [];
const vecino = new Map<number, number>(); // frase → índice de su frase más parecida en OTRA ficha
for (let x = 0; x < idx.length; x++) {
  const vx = indice.vectorDe(idx[x]!.i);
  let mejor = -1;
  let mejorS = -Infinity;
  for (let y = 0; y < idx.length; y++) {
    if (x === y || mismoTema(idx[x]!.clave, idx[y]!.clave)) continue;
    const vy = indice.vectorDe(idx[y]!.i);
    let s = 0;
    for (let k = 0; k < vx.length; k++) s += vx[k]! * vy[k]!;
    if (s > mejorS) {
      mejorS = s;
      mejor = y;
    }
    if (y > x && s >= 0.95) casi.push({ a: idx[x]!.texto, fa: nombre(idx[x]!.clave), b: idx[y]!.texto, fb: nombre(idx[y]!.clave), parecido: Math.round(s * 1000) / 1000 });
  }
  vecino.set(x, mejor);
}
const cuenta = new Map<number, number>();
for (const y of vecino.values()) cuenta.set(y, (cuenta.get(y) ?? 0) + 1);
const imanes = [...cuenta.entries()]
  .filter(([, n]) => n >= 5)
  .sort((a, b) => b[1] - a[1])
  .map(([y, n]) => ({ frase: idx[y]!.texto, ficha: nombre(idx[y]!.clave), atrae: n }));

casi.sort((a, b) => b.parecido - a.parecido);
console.log(`Textos idénticos en fichas distintas: ${identicos.length}`);
console.log(`Frases casi iguales (≥0,95) entre fichas distintas: ${casi.length}`);
console.log(`Frases imán (atraen 5 o más frases de otras fichas): ${imanes.length}`);
for (const x of identicos.slice(0, 10)) console.log(`  = "${x.texto}" en ${x.fichas.join(' y ')}`);
for (const x of imanes.slice(0, 8)) console.log(`  ⊙ "${x.frase}" (${x.ficha}) atrae ${x.atrae}`);

const iJson = process.argv.indexOf('--json');
if (iJson > 0 && process.argv[iJson + 1]) {
  writeFileSync(process.argv[iJson + 1]!, JSON.stringify({ identicos, casi, imanes }, null, 1));
  console.log(`reporte completo → ${process.argv[iJson + 1]}`);
}
